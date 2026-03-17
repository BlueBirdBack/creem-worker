/**
 * creem-worker — OpenClaw Plugin
 *
 * Autonomous AI agent that monitors a Creem store, sends alerts via Telegram,
 * and acts as a proactive operations employee.
 *
 * Features:
 *   • Real-time store monitoring (polling)
 *   • Smart alerts for sales, cancellations, payment failures
 *   • MRR tracking and churn detection
 *   • Daily digest summaries
 *   • Slash commands: /creem, /creem-stats, /creem-health, /creem-revenue
 *   • RPC methods for scripting
 *
 * Zero npm dependencies — uses node:sqlite (Node ≥22.5) and global fetch.
 *
 * Built by Ash & Six via agent-to-agent coordination.
 */

import { CreemClient } from "./src/api.ts";
import { checkForChanges, calculateMRR, loadState, saveState } from "./src/monitor.ts";
import { fmtChangeSet, fmtDailyDigest, type DailyDigestData } from "./src/alerts.ts";
import { createWebhookServer, webhookEventToAlertText, type CreemWebhookEvent } from "./src/webhook.ts";
import { setupDb, logTransaction, logSubscriptionEvent, saveDailySnapshot, getDayRevenue, cleanupOldData, getKv, setKv } from "./src/db.ts";
import { handleCreem, handleCreemStats, handleCreemHealth, handleCreemRevenue } from "./src/commands.ts";
import type { CreemWorkerConfig, DEFAULT_CONFIG, SubscriptionStatus } from "./src/types.ts";

// ── Telegram alert helper ────────────────────────────────────────────────────

async function tgAlert(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: undefined,  // plain text for max compatibility
      }),
    });
  } catch { /* never crash the plugin */ }
}

function getTgToken(config: any): string {
  try {
    const accounts = config?.channels?.telegram?.accounts ?? {};
    const first = Object.values(accounts)[0] as any;
    return first?.token ?? first?.botToken ?? "";
  } catch { return ""; }
}

// ── Plugin entry point ───────────────────────────────────────────────────────

export default function register(api: any) {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

  // Config with defaults
  const apiKey         = (cfg.apiKey as string) ?? "";
  const testMode       = (cfg.testMode as boolean) ?? false;
  const pollMs         = (cfg.pollIntervalMs as number) ?? 300_000;
  const alertChatId    = (cfg.alertChatId as string) ?? "";
  const dbPath         = (cfg.dbPath as string) ?? "/opt/creem-worker/creem.db";
  const statePath      = (cfg.statePath as string) ?? "/opt/creem-worker/state.json";
  const digestHour     = (cfg.dailyDigestHour as number) ?? 9;
  const mrrAlerts      = (cfg.mrrAlerts as boolean) ?? true;
  const webhookSecret  = (cfg.webhookSecret as string) ?? "";
  const webhookPort    = (cfg.webhookPort as number) ?? 9444;
  const webhookPath    = (cfg.webhookPath as string) ?? "/webhook/creem";

  if (!apiKey) {
    api.logger.warn("creem-worker: no apiKey configured — plugin disabled");
    return;
  }

  const client = new CreemClient({ apiKey, testMode });
  const db = setupDb(dbPath);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Polling loop ─────────────────────────────────────────────────────────

  async function poll() {
    try {
      const { changes, newState } = await checkForChanges(client, statePath, api.logger);

      // Log to SQLite
      for (const tx of changes.newTransactions) {
        logTransaction(db, {
          id: tx.id,
          amount: tx.amount,
          currency: tx.currency,
          status: tx.status,
          productId: tx.product?.id,
          productName: tx.product?.name,
          customerId: tx.customer?.id,
          customerEmail: tx.customer?.email,
          subscriptionId: tx.subscription_id,
        });
      }

      for (const sc of changes.subscriptionChanges) {
        logSubscriptionEvent(db, {
          subscriptionId: sc.subscriptionId,
          customerEmail: sc.customerEmail,
          productName: sc.productName,
          oldStatus: sc.previousStatus,
          newStatus: sc.newStatus,
        });
      }

      // MRR from Creem stats API (1 call vs 7 serial sub-status calls)
      let mrr = 0;
      try {
        const stats = await client.getStatsSummary();
        mrr = stats.totals.monthlyRecurringRevenue ?? 0;
      } catch {
        // Fallback to manual calculation
        try {
          const allSubs = await client.getAllSubscriptions();
          mrr = calculateMRR(allSubs);
        } catch { /* skip MRR if API fails */ }
      }

      // Save daily snapshot
      const today = new Date().toISOString().slice(0, 10);
      const dayRev = getDayRevenue(db, today);
      saveDailySnapshot(db, {
        date: today,
        customerCount: newState.customerCount,
        subscriptions: newState.subscriptions as Record<string, number>,
        revenueCents: dayRev.cents,
        transactionCount: dayRev.count,
        mrrCents: mrr,
      });

      // Save state
      saveState(statePath, newState);

      // Format & send alert
      const alertText = fmtChangeSet(changes);
      if (alertText) {
        const tgToken = getTgToken(api.config);
        if (tgToken && alertChatId) {
          await tgAlert(tgToken, alertChatId, alertText);
        }
        api.logger.info(`creem-worker: alert sent (${changes.newTransactions.length} tx, ${changes.subscriptionChanges.length} sub changes)`);
      }

      // Daily digest check
      await maybeSendDigest(today, mrr, newState);

    } catch (err: any) {
      api.logger.warn(`creem-worker: poll error: ${err.message}`);
    }
  }

  // ── Daily digest ─────────────────────────────────────────────────────────

  async function maybeSendDigest(today: string, mrr: number, state: any) {
    const hour = new Date().getHours();
    const lastDigest = getKv(db, "last_digest_date");

    if (hour >= digestHour && lastDigest !== today) {
      setKv(db, "last_digest_date", today);

      // Get yesterday's snapshot for comparison
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const dayRev = getDayRevenue(db, today);
      const prevState = loadState(statePath);

      const digestData: DailyDigestData = {
        date: today,
        transactionCount: dayRev.count,
        revenue: dayRev.cents,
        newCustomers: 0,  // will be enriched by monitor
        subscriptions: state.subscriptions,
        prevSubscriptions: prevState.subscriptions ?? {} as any,
        mrr,
        mrrChange: 0,  // TODO: compare with yesterday's snapshot
      };

      const digestText = fmtDailyDigest(digestData);
      const tgToken = getTgToken(api.config);
      if (tgToken && alertChatId) {
        await tgAlert(tgToken, alertChatId, digestText);
      }
    }
  }

  // ── Service: start/stop polling ──────────────────────────────────────────

  api.registerService({
    id: "creem-monitor",
    start: () => {
      api.logger.info(`creem-worker: starting monitor (poll every ${pollMs / 1000}s, ${testMode ? "TEST" : "LIVE"} mode)`);
      // Initial poll after 10s (let gateway settle)
      setTimeout(() => void poll(), 10_000);
      pollTimer = setInterval(() => void poll(), pollMs);
    },
    stop: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      api.logger.info("creem-worker: monitor stopped");
    },
  });

  // ── Cleanup service ────────────────────────────────────────────────────

  api.registerService({
    id: "creem-cleanup",
    start: () => {
      const deleted = cleanupOldData(db, 180);
      if (deleted > 0) {
        api.logger.info(`creem-worker: cleaned up ${deleted} old rows`);
      }
    },
    stop: () => {},
  });

  // ── Webhook service ────────────────────────────────────────────────────

  if (webhookSecret) {
    const webhook = createWebhookServer({
      secret: webhookSecret,
      port: webhookPort,
      path: webhookPath,
      logger: api.logger,
      onEvent: async (event: CreemWebhookEvent, severity: string) => {
        // Log event to db
        if (event.eventType === "checkout.completed") {
          const obj = event.object as any;
          logTransaction(db, {
            id: obj.order?.id ?? event.id,
            amount: obj.order?.amount ?? 0,
            currency: obj.order?.currency ?? "USD",
            status: "completed",
            productId: obj.product?.id,
            productName: obj.product?.name,
            customerId: obj.customer?.id,
            customerEmail: obj.customer?.email,
            subscriptionId: obj.subscription?.id,
          });
        }

        if (event.eventType.startsWith("subscription.")) {
          const obj = event.object as any;
          const newStatus = event.eventType.replace("subscription.", "") as string;
          logSubscriptionEvent(db, {
            subscriptionId: obj.id ?? event.id,
            customerEmail: obj.customer?.email,
            productName: obj.product?.name,
            oldStatus: "unknown",
            newStatus,
          });
        }

        // Format and send Telegram alert
        const alertText = webhookEventToAlertText(event);
        const tgToken = getTgToken(api.config);
        if (tgToken && alertChatId) {
          await tgAlert(tgToken, alertChatId, alertText);
        }

        api.logger.info(`creem-webhook: processed ${event.eventType} (${severity})`);
      },
    });

    api.registerService({
      id: "creem-webhook",
      start: () => webhook.start(),
      stop: () => webhook.stop(),
    });
  } else {
    api.logger.info("creem-worker: no webhookSecret — webhook listener disabled (polling only)");
  }

  // ── Slash commands ─────────────────────────────────────────────────────

  api.registerCommand({
    name: "creem",
    description: "Creem store status — customers, subscriptions, recent sales, MRR",
    requireAuth: true,
    handler: async () => handleCreem(client, statePath),
  });

  api.registerCommand({
    name: "creem-stats",
    description: "Revenue stats. Usage: /creem-stats [today|week|month]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => handleCreemStats(db, ctx.args ?? ""),
  });

  api.registerCommand({
    name: "creem-health",
    description: "Subscription health check — active, past due, churn risk",
    requireAuth: true,
    handler: async () => handleCreemHealth(client),
  });

  api.registerCommand({
    name: "creem-revenue",
    description: "MRR, ARR, and revenue trends",
    requireAuth: true,
    handler: async () => handleCreemRevenue(client, db),
  });

  // ── RPC methods ────────────────────────────────────────────────────────

  api.registerGatewayMethod("creem.status", async ({ respond }: any) => {
    const state = loadState(statePath);
    let mrr = 0;
    try {
      const allSubs = await client.getAllSubscriptions();
      mrr = calculateMRR(allSubs);
    } catch { /* skip */ }
    respond(true, { ...state, mrr });
  });

  api.registerGatewayMethod("creem.transactions", async ({ respond }: any) => {
    try {
      const txResp = await client.getTransactions({ pageSize: 20 });
      respond(true, txResp);
    } catch (e: any) {
      respond(false, { error: e.message });
    }
  });

  api.registerGatewayMethod("creem.subscriptions", async ({ respond }: any) => {
    try {
      const allSubs = await client.getAllSubscriptions();
      const counts: Record<string, number> = {};
      for (const [status, subs] of Object.entries(allSubs)) {
        counts[status] = subs.length;
      }
      respond(true, { counts, mrr: calculateMRR(allSubs) });
    } catch (e: any) {
      respond(false, { error: e.message });
    }
  });

  api.registerGatewayMethod("creem.health", async ({ respond }: any) => {
    try {
      const ok = await client.ping();
      respond(true, { healthy: ok, mode: testMode ? "test" : "live" });
    } catch (e: any) {
      respond(false, { healthy: false, error: e.message });
    }
  });

  // ── Done ───────────────────────────────────────────────────────────────

  const mode = testMode ? "🧪 TEST" : "🔴 LIVE";
  api.logger.info(`creem-worker: ready — ${mode} mode, db=${dbPath}, poll=${pollMs / 1000}s`);
}
