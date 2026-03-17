import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  verifySignature,
  webhookEventToAlertText,
  type CreemWebhookEvent,
} from "../src/webhook.ts";

const SECRET = "top-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeEvent(
  eventType: CreemWebhookEvent["eventType"],
  object: Record<string, unknown>,
): CreemWebhookEvent {
  return {
    id: "evt_test",
    eventType,
    created_at: 1_710_000_000_000,
    object,
  };
}

test("verifySignature accepts a valid signature", () => {
  const rawBody = JSON.stringify({ id: "evt_valid", ok: true });
  const signature = sign(rawBody);

  assert.equal(verifySignature(rawBody, signature, SECRET), true);
});

test("verifySignature rejects an invalid signature", () => {
  const rawBody = JSON.stringify({ id: "evt_invalid" });

  assert.equal(verifySignature(rawBody, "deadbeef", SECRET), false);
});

test("verifySignature rejects an empty signature", () => {
  const rawBody = JSON.stringify({ id: "evt_empty" });

  assert.equal(verifySignature(rawBody, "", SECRET), false);
});

test("verifySignature rejects a tampered body", () => {
  const originalBody = JSON.stringify({ id: "evt_body", amount: 1299 });
  const signature = sign(originalBody);
  const tamperedBody = JSON.stringify({ id: "evt_body", amount: 1399 });

  assert.equal(verifySignature(tamperedBody, signature, SECRET), false);
});

test("webhookEventToAlertText formats checkout.completed", () => {
  const text = webhookEventToAlertText(
    makeEvent("checkout.completed", {
      customer: { email: "buyer@example.com" },
      product: { name: "Pro Plan" },
      order: { amount: 1999, currency: "USD" },
    }),
  );

  assert.equal(
    text,
    "💰 New Sale (webhook)\nProduct: Pro Plan ($19.99 USD)\nCustomer: buyer@example.com",
  );
});

test("webhookEventToAlertText formats subscription.canceled", () => {
  const text = webhookEventToAlertText(
    makeEvent("subscription.canceled", {
      customer: { email: "cancelled@example.com" },
      product: { name: "Starter" },
    }),
  );

  assert.equal(
    text,
    "⚠️ Subscription Canceled (webhook)\nCustomer: cancelled@example.com\nProduct: Starter",
  );
});

test("webhookEventToAlertText formats subscription.past_due", () => {
  const text = webhookEventToAlertText(
    makeEvent("subscription.past_due", {
      customer: { email: "late@example.com" },
      product: { name: "Growth" },
    }),
  );

  assert.equal(
    text,
    "🚨 Payment Failed (webhook)\nCustomer: late@example.com\nProduct: Growth\nAction: Creem will retry automatically",
  );
});

test("webhookEventToAlertText formats refund.created", () => {
  const text = webhookEventToAlertText(
    makeEvent("refund.created", {
      customer: { email: "refund@example.com" },
      refund_amount: 2500,
      reason: "requested_by_customer",
    }),
  );

  assert.equal(
    text,
    "💸 Refund Created\nCustomer: refund@example.com\nAmount: $25.00\nReason: requested_by_customer",
  );
});

test("webhookEventToAlertText formats dispute.created", () => {
  const text = webhookEventToAlertText(
    makeEvent("dispute.created", {
      customer: { email: "chargeback@example.com" },
      amount: 4500,
    }),
  );

  assert.equal(
    text,
    "🔥 CHARGEBACK\nCustomer: chargeback@example.com\nAmount: $45.00\nAction required immediately",
  );
});

test("webhookEventToAlertText falls back for missing fields and zero amounts", () => {
  const checkoutText = webhookEventToAlertText(
    makeEvent("checkout.completed", {
      order: { amount: 0, currency: "USD" },
    }),
  );
  const refundText = webhookEventToAlertText(
    makeEvent("refund.created", {
      refund_amount: 0,
    }),
  );
  const disputeText = webhookEventToAlertText(
    makeEvent("dispute.created", {
      amount: 0,
    }),
  );

  assert.equal(
    checkoutText,
    "💰 New Sale (webhook)\nProduct: unknown ($0.00 USD)\nCustomer: unknown",
  );
  assert.equal(
    refundText,
    "💸 Refund Created\nCustomer: unknown\nAmount: $0.00\nReason: not specified",
  );
  assert.equal(
    disputeText,
    "🔥 CHARGEBACK\nCustomer: unknown\nAmount: $0.00\nAction required immediately",
  );
});
