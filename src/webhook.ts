/**
 * webhook.ts — Creem Webhook Handler (plugin-integrated)
 *
 * Verifies HMAC-SHA256 signatures, parses events, routes to alert pipeline.
 * Designed to run as an OpenClaw plugin service via createWebhookServer().
 *
 * Creem retries on non-200: 30s → 1m → 5m → 1h
 *
 * Original standalone by Six ⚡ — refactored for plugin integration by Ash 🌿
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreemTransaction,
  CreemSubscription,
  CreemCustomer,
  SubscriptionStatus,
} from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreemWebhookEvent {
  id: string;                // evt_...
  eventType: CreemEventType;
  created_at: number;        // unix ms
  object: Record<string, unknown>;
}

export type CreemEventType =
  | "checkout.completed"
  | "subscription.active"
  | "subscription.trialing"
  | "subscription.paid"
  | "subscription.canceled"
  | "subscription.scheduled_cancel"
  | "subscription.past_due"
  | "subscription.expired"
  | "subscription.update"
  | "refund.created"
  | "dispute.created";

export interface WebhookServerOptions {
  secret: string;
  port?: number;
  path?: string;
  onEvent: (event: CreemWebhookEvent, severity: "info" | "warn" | "critical") => void | Promise<void>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

// ── Severity mapping ─────────────────────────────────────────────────────────

const EVENT_SEVERITY: Record<string, "info" | "warn" | "critical"> = {
  "checkout.completed":            "info",
  "subscription.active":           "info",
  "subscription.trialing":          "info",
  "subscription.paid":             "info",
  "subscription.update":           "info",
  "subscription.scheduled_cancel": "warn",
  "subscription.past_due":         "warn",
  "subscription.canceled":         "warn",
  "subscription.expired":          "critical",
  "refund.created":                "critical",
  "dispute.created":               "critical",
};

// ── Signature verification ───────────────────────────────────────────────────

export function verifySignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) return false;

  const computed = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signatureHeader, "hex"),
    );
  } catch {
    return false;
  }
}

// ── Event → alert text conversion ────────────────────────────────────────────

export function webhookEventToAlertText(event: CreemWebhookEvent): string {
  const obj = event.object as any;
  const customer = obj.customer?.email ?? obj.email ?? "unknown";
  const product = obj.product?.name ?? obj.name ?? "unknown";

  switch (event.eventType) {
    case "checkout.completed": {
      const amount = (obj.order?.amount ?? obj.amount ?? 0) / 100;
      const currency = obj.order?.currency ?? obj.currency ?? "USD";
      return `💰 New Sale (webhook)\nProduct: ${product} ($${amount.toFixed(2)} ${currency})\nCustomer: ${customer}`;
    }
    case "subscription.active":
    case "subscription.trialing":
    case "subscription.paid":
      return `✅ Subscription Payment\nCustomer: ${customer}\nProduct: ${product}\nStatus: active`;

    case "subscription.canceled":
      return `⚠️ Subscription Canceled (webhook)\nCustomer: ${customer}\nProduct: ${product}`;

    case "subscription.scheduled_cancel":
      return `⏳ Cancellation Scheduled\nCustomer: ${customer}\nProduct: ${product}\nAccess until: ${obj.current_period_end_date ?? "?"}`;

    case "subscription.past_due":
      return `🚨 Payment Failed (webhook)\nCustomer: ${customer}\nProduct: ${product}\nAction: Creem will retry automatically`;

    case "subscription.expired":
      return `💀 Subscription Expired\nCustomer: ${customer}\nProduct: ${product}`;

    case "subscription.update":
      return `📋 Subscription Updated\nSubscription: ${obj.id}\nStatus: ${obj.status ?? "?"}`;

    case "refund.created": {
      const amount = (obj.refund_amount ?? 0) / 100;
      return `💸 Refund Created\nCustomer: ${customer}\nAmount: $${amount.toFixed(2)}\nReason: ${obj.reason ?? "not specified"}`;
    }
    case "dispute.created": {
      const amount = (obj.amount ?? 0) / 100;
      return `🔥 CHARGEBACK\nCustomer: ${customer}\nAmount: $${amount.toFixed(2)}\nAction required immediately`;
    }
    default:
      return `📋 Creem Event: ${event.eventType}\n${JSON.stringify(obj).slice(0, 200)}`;
  }
}

// ── HTTP body reader ─────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Server factory ───────────────────────────────────────────────────────────

export function createWebhookServer(opts: WebhookServerOptions): {
  start: () => void;
  stop: () => void;
} {
  const port = opts.port ?? 9444;
  const path = opts.path ?? "/webhook/creem";
  const log = opts.logger ?? { info: console.log, warn: console.warn };
  let server: Server | null = null;

  function start() {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
        return;
      }

      // Only accept POST to webhook path
      if (req.method !== "POST" || !req.url?.startsWith(path)) {
        res.writeHead(404);
        res.end();
        return;
      }

      try {
        const rawBody = await readBody(req);
        const signature = (req.headers["creem-signature"] as string) ?? "";

        // Verify HMAC
        if (!verifySignature(rawBody, signature, opts.secret)) {
          log.warn("creem-webhook: invalid signature — rejecting");
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid signature" }));
          return;
        }

        // Parse event
        const event: CreemWebhookEvent = JSON.parse(rawBody);
        const severity = EVENT_SEVERITY[event.eventType] ?? "info";
        log.info(
          `creem-webhook: ← ${event.eventType} (${severity}) id=${event.id}`
        );

        // Respond 200 immediately (Creem retries on non-200)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));

        // Process async
        try {
          await opts.onEvent(event, severity);
        } catch (err: any) {
          log.warn(`creem-webhook: handler error for ${event.eventType}: ${err.message}`);
        }
      } catch (err) {
        log.warn(`creem-webhook: parse error: ${err}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });

    server.listen(port, "0.0.0.0", () => {
      log.info(`creem-webhook: listening on :${port}${path}`);
    });
  }

  function stop() {
    if (server) {
      server.close();
      server = null;
      log.info("creem-webhook: stopped");
    }
  }

  return { start, stop };
}
