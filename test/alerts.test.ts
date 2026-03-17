import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  fmtChangeSet,
  fmtDailyDigest,
  fmtNewCustomer,
  fmtNewSale,
  fmtStoreSnapshot,
  fmtSubscriptionChange,
} from "../src/alerts.ts";
import type {
  ChangeSet,
  CreemCustomer,
  CreemProduct,
  CreemTransaction,
  SubscriptionChange,
  SubscriptionStatus,
} from "../src/types.ts";

const FIXED_NOW_ISO = "2026-03-17T12:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const REAL_DATE_NOW = Date.now;
const STATUSES: SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
  "expired",
  "scheduled_cancel",
];

beforeEach(() => {
  Date.now = () => FIXED_NOW_MS;
});

afterEach(() => {
  Date.now = REAL_DATE_NOW;
});

function zeroCounts(): Record<SubscriptionStatus, number> {
  return {
    active: 0,
    trialing: 0,
    past_due: 0,
    paused: 0,
    canceled: 0,
    expired: 0,
    scheduled_cancel: 0,
  };
}

function makeProduct(overrides: Partial<CreemProduct> = {}): CreemProduct {
  return {
    id: "prod_1",
    name: "Pro Plan",
    price: 2500,
    currency: "USD",
    billing_type: "recurring",
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<CreemCustomer> = {}): CreemCustomer {
  return {
    id: "cus_1",
    email: "buyer@example.com",
    created_at: "2026-03-17T11:30:00.000Z",
    updated_at: "2026-03-17T11:30:00.000Z",
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<CreemTransaction> = {}): CreemTransaction {
  return {
    id: "tx_1",
    amount: 2500,
    currency: "USD",
    status: "paid",
    product: makeProduct(),
    customer: makeCustomer(),
    created_at: "2026-03-17T11:30:00.000Z",
    ...overrides,
  };
}

function makeSubscriptionChange(
  overrides: Partial<SubscriptionChange> = {},
): SubscriptionChange {
  return {
    subscriptionId: "sub_1",
    previousStatus: "trialing",
    newStatus: "active",
    customerEmail: "buyer@example.com",
    productName: "Pro Plan",
    ...overrides,
  };
}

function makeChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    newTransactions: [],
    subscriptionChanges: [],
    newCustomers: [],
    subscriptionCounts: zeroCounts(),
    previousCounts: zeroCounts(),
    totalRevenue: 0,
    timestamp: FIXED_NOW_ISO,
    ...overrides,
  };
}

test("fmtNewSale formats EUR sales and subscription purchases", () => {
  const msg = fmtNewSale(makeTransaction({
    amount: 0,
    currency: "EUR",
    subscription_id: "sub_123",
    created_at: "2026-03-17T11:59:45.000Z",
  }));

  assert.equal(
    msg,
    [
      "💰 New Sale",
      "Product: Pro Plan (€0.00)",
      "Customer: buyer@example.com",
      "Type: Subscription",
      "Time: just now",
    ].join("\n"),
  );
});

test("fmtNewSale falls back when optional product and customer fields are missing", () => {
  const msg = fmtNewSale(makeTransaction({
    product: undefined,
    customer: undefined,
    created_at: "2026-03-17T10:00:00.000Z",
  }));

  assert.equal(
    msg,
    [
      "💰 New Sale",
      "Product: Unknown product ($25.00)",
      "Customer: Unknown",
      "Type: One-time",
      "Time: 2h ago",
    ].join("\n"),
  );
});

test("fmtSubscriptionChange includes optional fields when present", () => {
  const msg = fmtSubscriptionChange(makeSubscriptionChange({
    previousStatus: "paused",
    newStatus: "active",
  }));

  assert.equal(
    msg,
    [
      "🎉 Subscription Resumed",
      "Customer: buyer@example.com",
      "Product: Pro Plan",
      "Status: ⏸️ paused → ✅ active",
    ].join("\n"),
  );
});

test("fmtSubscriptionChange covers every status transition", () => {
  for (const previousStatus of STATUSES) {
    for (const newStatus of STATUSES) {
      const msg = fmtSubscriptionChange(makeSubscriptionChange({
        previousStatus,
        newStatus,
        customerEmail: undefined,
        productName: undefined,
      }));

      const lines = msg.split("\n");
      const expectedHeader = newStatus === "past_due"
        ? "🚨 Payment Failed"
        : newStatus === "canceled" || newStatus === "scheduled_cancel"
          ? "⚠️ Subscription Canceled"
          : newStatus === "active" && previousStatus === "paused"
            ? "🎉 Subscription Resumed"
            : newStatus === "expired"
              ? "💀 Subscription Expired"
              : "📋 Subscription Changed";

      assert.equal(lines[0], expectedHeader, `${previousStatus} -> ${newStatus}`);
      assert.equal(
        lines[1],
        `Status: ${emoji(previousStatus)} ${previousStatus} → ${emoji(newStatus)} ${newStatus}`,
        `${previousStatus} -> ${newStatus}`,
      );

      if (newStatus === "past_due") {
        assert.equal(lines[2], "");
        assert.equal(
          lines[3],
          "Creem will retry automatically. Consider reaching out if this persists.",
        );
      } else if (newStatus === "scheduled_cancel") {
        assert.equal(lines[2], "");
        assert.equal(
          lines[3],
          "Customer will lose access at period end. Good time to intervene.",
        );
      } else {
        assert.equal(lines.length, 2, `${previousStatus} -> ${newStatus}`);
      }
    }
  }
});

test("fmtNewCustomer omits optional fields when absent", () => {
  const msg = fmtNewCustomer(makeCustomer({
    email: "new@example.com",
    name: undefined,
    country: undefined,
    created_at: "2026-03-17T11:00:00.000Z",
  }));

  assert.equal(
    msg,
    [
      "👋 New Customer",
      "Email: new@example.com",
      "Joined: 1h ago",
    ].join("\n"),
  );
});

test("fmtChangeSet returns a single sale directly", () => {
  const tx = makeTransaction({
    amount: 0,
    created_at: "2026-03-16T12:00:00.000Z",
  });

  assert.equal(
    fmtChangeSet(makeChangeSet({
      newTransactions: [tx],
      totalRevenue: tx.amount,
    })),
    [
      "💰 New Sale",
      "Product: Pro Plan ($0.00)",
      "Customer: buyer@example.com",
      "Type: One-time",
      "Time: 2026-03-16",
    ].join("\n"),
  );
});

test("fmtChangeSet summarizes multiple sales and includes only unmatched new customers", () => {
  const first = makeTransaction({
    id: "tx_1",
    amount: 1999,
    customer: makeCustomer({ id: "cus_1", email: "buyer@example.com" }),
  });
  const second = makeTransaction({
    id: "tx_2",
    amount: 500,
    product: makeProduct({ id: "prod_2", name: "Addon" }),
    customer: makeCustomer({ id: "cus_2", email: "second@example.com" }),
    created_at: "2026-03-17T11:45:00.000Z",
  });
  const msg = fmtChangeSet(makeChangeSet({
    newTransactions: [first, second],
    newCustomers: [
      makeCustomer({ id: "cus_1", email: "buyer@example.com" }),
      makeCustomer({
        id: "cus_3",
        email: "fresh@example.com",
        name: "Fresh Customer",
        country: "DE",
        created_at: "2026-03-17T11:58:00.000Z",
      }),
    ],
    totalRevenue: 2499,
  }));

  assert.equal(
    msg,
    [
      "💰 2 New Sales ($24.99 total)",
      "  • Pro Plan — $19.99 — buyer@example.com",
      "  • Addon — $5.00 — second@example.com",
      "",
      "👋 New Customer",
      "Email: fresh@example.com",
      "Name: Fresh Customer",
      "Country: DE",
      "Joined: 2m ago",
    ].join("\n"),
  );
});

test("fmtChangeSet returns null for an empty change set", () => {
  assert.equal(fmtChangeSet(makeChangeSet()), null);
});

test("fmtChangeSet adds a churn alert after three lost subscriptions", () => {
  const msg = fmtChangeSet(makeChangeSet({
    subscriptionChanges: [
      makeSubscriptionChange({
        subscriptionId: "sub_a",
        previousStatus: "active",
        newStatus: "canceled",
        customerEmail: "one@example.com",
        productName: "Starter",
      }),
      makeSubscriptionChange({
        subscriptionId: "sub_b",
        previousStatus: "past_due",
        newStatus: "expired",
        customerEmail: "two@example.com",
        productName: "Pro",
      }),
      makeSubscriptionChange({
        subscriptionId: "sub_c",
        previousStatus: "active",
        newStatus: "scheduled_cancel",
        customerEmail: "three@example.com",
        productName: "Scale",
      }),
    ],
  }));

  assert.equal(
    msg,
    [
      "⚠️ Subscription Canceled",
      "Customer: one@example.com",
      "Product: Starter",
      "Status: ✅ active → ❌ canceled",
      "",
      "💀 Subscription Expired",
      "Customer: two@example.com",
      "Product: Pro",
      "Status: 🚨 past_due → 💀 expired",
      "",
      "⚠️ Subscription Canceled",
      "Customer: three@example.com",
      "Product: Scale",
      "Status: ✅ active → ⏳ scheduled_cancel",
      "",
      "Customer will lose access at period end. Good time to intervene.",
      "",
      "📉 Churn Alert: 3 subscriptions lost in this check. Investigate.",
    ].join("\n"),
  );
});

test("fmtDailyDigest formats revenue, MRR deltas, subscription deltas, and warnings", () => {
  const subscriptions = zeroCounts();
  subscriptions.active = 10;
  subscriptions.trialing = 2;
  subscriptions.past_due = 1;
  subscriptions.canceled = 4;

  const prevSubscriptions = zeroCounts();
  prevSubscriptions.active = 8;
  prevSubscriptions.trialing = 3;
  prevSubscriptions.canceled = 4;

  const msg = fmtDailyDigest({
    date: "2026-03-17",
    transactionCount: 3,
    revenue: 0,
    newCustomers: 2,
    subscriptions,
    prevSubscriptions,
    mrr: 12345,
    mrrChange: -500,
  });

  assert.equal(
    msg,
    [
      "📊 Creem Daily Digest — 2026-03-17",
      "",
      "Revenue: $0.00 (3 transactions)",
      "New customers: 2",
      "MRR: $123.45 ↓ $5.00",
      "",
      "Subscriptions:",
      "  ✅ active: 10 (+2)",
      "  🔬 trialing: 2 (-1)",
      "  🚨 past_due: 1 (+1)",
      "  ❌ canceled: 4",
      "",
      "⚠️ 1 subscription past due — revenue at risk",
    ].join("\n"),
  );
});

test("fmtStoreSnapshot formats totals and recent sales", () => {
  const subscriptions = zeroCounts();
  subscriptions.active = 5;
  subscriptions.trialing = 1;
  subscriptions.past_due = 2;

  const msg = fmtStoreSnapshot({
    customerCount: 12,
    subscriptions,
    recentTransactions: [
      makeTransaction({
        amount: 0,
        created_at: "2026-03-17T11:15:00.000Z",
      }),
      makeTransaction({
        id: "tx_2",
        amount: 999,
        product: makeProduct({ id: "prod_2", name: "Addon" }),
        created_at: "2026-03-16T11:00:00.000Z",
      }),
    ],
    mrr: 0,
  });

  assert.equal(
    msg,
    [
      "🏪 Creem Store Status",
      "",
      "Customers: 12",
      "MRR: $0.00",
      "",
      "Subscriptions: 8",
      "  ✅ active: 5",
      "  🔬 trialing: 1",
      "  🚨 past_due: 2",
      "",
      "Recent sales:",
      "  • $0.00 — Pro Plan — 45m ago",
      "  • $9.99 — Addon — 2026-03-16",
    ].join("\n"),
  );
});

function emoji(status: SubscriptionStatus): string {
  switch (status) {
    case "active":
      return "✅";
    case "trialing":
      return "🔬";
    case "past_due":
      return "🚨";
    case "paused":
      return "⏸️";
    case "canceled":
      return "❌";
    case "expired":
      return "💀";
    case "scheduled_cancel":
      return "⏳";
  }
}
