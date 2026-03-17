import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { calculateMRR, loadState, saveState } from "../src/monitor.ts";
import type {
  CreemSubscription,
  StoreSnapshot,
  SubscriptionStatus,
} from "../src/types.ts";

function createEmptySnapshot(): StoreSnapshot {
  return {
    lastCheckAt: null,
    lastTransactionId: null,
    transactionCount: 0,
    customerCount: 0,
    subscriptions: {
      active: 0,
      trialing: 0,
      past_due: 0,
      paused: 0,
      canceled: 0,
      expired: 0,
      scheduled_cancel: 0,
    },
    knownSubscriptions: {},
  };
}

function createSubscription(
  id: string,
  billingPeriod?: "every-month" | "every-three-months" | "every-six-months" | "every-year",
  price = 0,
): CreemSubscription {
  return {
    id,
    status: "active",
    product: {
      id: `product-${id}`,
      name: `Product ${id}`,
      price,
      currency: "USD",
      billing_type: billingPeriod ? "recurring" : "onetime",
      billing_period: billingPeriod,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    customer: {
      id: `customer-${id}`,
      email: `${id}@example.com`,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function createSubscriptions(
  active: CreemSubscription[],
): Record<SubscriptionStatus, CreemSubscription[]> {
  return {
    active,
    trialing: [],
    past_due: [],
    paused: [],
    canceled: [],
    expired: [],
    scheduled_cancel: [],
  };
}

test("loadState returns an empty snapshot when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "creem-worker-monitor-"));

  try {
    const missingPath = join(dir, "missing", "state.json");
    assert.deepStrictEqual(loadState(missingPath), createEmptySnapshot());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveState and loadState roundtrip a snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "creem-worker-monitor-"));

  try {
    const statePath = join(dir, "nested", "state.json");
    const snapshot: StoreSnapshot = {
      lastCheckAt: "2026-03-17T12:00:00.000Z",
      lastTransactionId: "tx_123",
      transactionCount: 42,
      customerCount: 9,
      subscriptions: {
        active: 3,
        trialing: 2,
        past_due: 1,
        paused: 1,
        canceled: 4,
        expired: 5,
        scheduled_cancel: 6,
      },
      knownSubscriptions: {
        sub_active: "active",
        sub_trialing: "trialing",
      },
    };

    saveState(statePath, snapshot);

    assert.deepStrictEqual(loadState(statePath), snapshot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calculateMRR counts monthly billing at full price", () => {
  const subs = createSubscriptions([createSubscription("monthly", "every-month", 1500)]);
  assert.strictEqual(calculateMRR(subs), 1500);
});

test("calculateMRR normalizes quarterly billing to monthly revenue", () => {
  const subs = createSubscriptions([createSubscription("quarterly", "every-three-months", 3000)]);
  assert.strictEqual(calculateMRR(subs), 1000);
});

test("calculateMRR normalizes semi-annual billing to monthly revenue", () => {
  const subs = createSubscriptions([createSubscription("semi-annual", "every-six-months", 6000)]);
  assert.strictEqual(calculateMRR(subs), 1000);
});

test("calculateMRR normalizes annual billing to monthly revenue", () => {
  const subs = createSubscriptions([createSubscription("annual", "every-year", 12000)]);
  assert.strictEqual(calculateMRR(subs), 1000);
});

test("calculateMRR ignores one-time billing", () => {
  const subs = createSubscriptions([createSubscription("one-time", undefined, 5000)]);
  assert.strictEqual(calculateMRR(subs), 0);
});
