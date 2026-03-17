import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import test, { type TestContext } from "node:test";

import {
  cleanupOldData,
  getDayRevenue,
  getKv,
  getRevenueRange,
  logSubscriptionEvent,
  logTransaction,
  saveDailySnapshot,
  setKv,
  setupDb,
} from "../src/db.ts";

function tempDbPath(): string {
  return `/tmp/creem-test-db-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
}

function createTestDb(t: TestContext) {
  const dbPath = tempDbPath();
  const db = setupDb(dbPath);

  t.after(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  return { db, dbPath };
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function toTimestamp(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function plainObject<T extends object>(value: T): T {
  return { ...value };
}

function plainRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => plainObject(row));
}

function insertTransaction(
  db: ReturnType<typeof setupDb>,
  {
    id,
    date,
    amount,
  }: {
    id: string;
    date: string;
    amount: number;
  },
): void {
  db.prepare(`
    INSERT INTO transactions
      (id, ts, date, amount, currency, status, product_id, product_name,
       customer_id, customer_email, subscription_id, is_recurring)
    VALUES (?, ?, ?, ?, 'USD', 'paid', NULL, NULL, NULL, NULL, NULL, 0)
  `).run(id, toTimestamp(date), date, amount);
}

test("setupDb creates all expected tables", (t) => {
  const { db, dbPath } = createTestDb(t);
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.ok(existsSync(dbPath));
  assert.deepStrictEqual(
    tables.map((table) => table.name).filter((name) => !name.startsWith("sqlite_")),
    ["daily_snapshots", "kv", "subscription_events", "transactions"],
  );
});

test("logTransaction inserts once and deduplicates by primary key", (t) => {
  const { db } = createTestDb(t);

  logTransaction(db, {
    id: "tx_1",
    amount: 1999,
    currency: "USD",
    status: "paid",
    productId: "prod_1",
    productName: "Pro",
    customerId: "cust_1",
    customerEmail: "buyer@example.com",
    subscriptionId: "sub_1",
  });

  logTransaction(db, {
    id: "tx_1",
    amount: 4999,
    currency: "USD",
    status: "refunded",
  });

  const row = db.prepare(`
    SELECT id, amount, status, subscription_id, is_recurring
    FROM transactions
    WHERE id = ?
  `).get("tx_1") as {
    id: string;
    amount: number;
    status: string;
    subscription_id: string;
    is_recurring: number;
  };

  const count = db.prepare("SELECT COUNT(*) AS count FROM transactions").get() as { count: number };

  assert.strictEqual(count.count, 1);
  assert.strictEqual(row.id, "tx_1");
  assert.strictEqual(row.amount, 1999);
  assert.strictEqual(row.status, "paid");
  assert.strictEqual(row.subscription_id, "sub_1");
  assert.strictEqual(row.is_recurring, 1);
});

test("logSubscriptionEvent inserts a subscription event row", (t) => {
  const { db } = createTestDb(t);

  logSubscriptionEvent(db, {
    subscriptionId: "sub_42",
    customerEmail: "subscriber@example.com",
    productName: "Growth",
    oldStatus: "trialing",
    newStatus: "active",
  });

  const row = db.prepare(`
    SELECT subscription_id, customer_email, product_name, old_status, new_status
    FROM subscription_events
  `).get() as {
    subscription_id: string;
    customer_email: string;
    product_name: string;
    old_status: string;
    new_status: string;
  };

  assert.deepStrictEqual(plainObject(row), {
    subscription_id: "sub_42",
    customer_email: "subscriber@example.com",
    product_name: "Growth",
    old_status: "trialing",
    new_status: "active",
  });
});

test("saveDailySnapshot inserts and replaces by date", (t) => {
  const { db } = createTestDb(t);
  const date = daysAgo(0);

  saveDailySnapshot(db, {
    date,
    customerCount: 10,
    subscriptions: { active: 7, trialing: 2 },
    revenueCents: 2500,
    transactionCount: 3,
    mrrCents: 1800,
  });

  saveDailySnapshot(db, {
    date,
    customerCount: 12,
    subscriptions: { active: 8, canceled: 1, scheduled_cancel: 2 },
    revenueCents: 3200,
    transactionCount: 4,
    mrrCents: 2100,
  });

  const row = db.prepare(`
    SELECT
      customer_count,
      active_subs,
      trialing_subs,
      canceled_subs,
      scheduled_cancel_subs,
      revenue_cents,
      transaction_count,
      mrr_cents
    FROM daily_snapshots
    WHERE date = ?
  `).get(date) as {
    customer_count: number;
    active_subs: number;
    trialing_subs: number;
    canceled_subs: number;
    scheduled_cancel_subs: number;
    revenue_cents: number;
    transaction_count: number;
    mrr_cents: number;
  };

  const count = db.prepare("SELECT COUNT(*) AS count FROM daily_snapshots WHERE date = ?").get(date) as {
    count: number;
  };

  assert.strictEqual(count.count, 1);
  assert.deepStrictEqual(plainObject(row), {
    customer_count: 12,
    active_subs: 8,
    trialing_subs: 0,
    canceled_subs: 1,
    scheduled_cancel_subs: 2,
    revenue_cents: 3200,
    transaction_count: 4,
    mrr_cents: 2100,
  });
});

test("getDayRevenue returns the transaction count and cents for a day", (t) => {
  const { db } = createTestDb(t);
  const targetDate = "2026-03-10";

  insertTransaction(db, { id: "tx_day_1", date: targetDate, amount: 1500 });
  insertTransaction(db, { id: "tx_day_2", date: targetDate, amount: 2500 });
  insertTransaction(db, { id: "tx_day_3", date: "2026-03-11", amount: 4000 });

  assert.deepStrictEqual(getDayRevenue(db, targetDate), {
    count: 2,
    cents: 4000,
  });
});

test("getRevenueRange filters transactions by inclusive date range", (t) => {
  const { db } = createTestDb(t);

  insertTransaction(db, { id: "tx_range_1", date: "2026-03-09", amount: 1000 });
  insertTransaction(db, { id: "tx_range_2", date: "2026-03-10", amount: 2000 });
  insertTransaction(db, { id: "tx_range_3", date: "2026-03-10", amount: 500 });
  insertTransaction(db, { id: "tx_range_4", date: "2026-03-11", amount: 3000 });
  insertTransaction(db, { id: "tx_range_5", date: "2026-03-12", amount: 7000 });

  assert.deepStrictEqual(
    plainRows(getRevenueRange(db, "2026-03-10", "2026-03-11")),
    [
      { date: "2026-03-11", count: 1, cents: 3000 },
      { date: "2026-03-10", count: 2, cents: 2500 },
    ],
  );
});

test("cleanupOldData removes rows older than the retention window", (t) => {
  const { db } = createTestDb(t);
  const oldDate = daysAgo(45);
  const recentDate = daysAgo(5);

  insertTransaction(db, { id: "tx_old", date: oldDate, amount: 1000 });
  insertTransaction(db, { id: "tx_recent", date: recentDate, amount: 2000 });

  db.prepare(`
    INSERT INTO subscription_events
      (ts, date, subscription_id, customer_email, product_name, old_status, new_status)
    VALUES (?, ?, ?, NULL, NULL, 'active', 'canceled')
  `).run(toTimestamp(oldDate), oldDate, "sub_old");
  db.prepare(`
    INSERT INTO subscription_events
      (ts, date, subscription_id, customer_email, product_name, old_status, new_status)
    VALUES (?, ?, ?, NULL, NULL, 'trialing', 'active')
  `).run(toTimestamp(recentDate), recentDate, "sub_recent");

  db.prepare(`
    INSERT INTO daily_snapshots
      (date, customer_count, revenue_cents, transaction_count, mrr_cents)
    VALUES (?, 1, 1000, 1, 1000)
  `).run(oldDate);
  db.prepare(`
    INSERT INTO daily_snapshots
      (date, customer_count, revenue_cents, transaction_count, mrr_cents)
    VALUES (?, 2, 2000, 2, 2000)
  `).run(recentDate);

  const removed = cleanupOldData(db, 30);

  const remainingTransactions = db.prepare("SELECT id FROM transactions ORDER BY id").all() as Array<{ id: string }>;
  const remainingEvents = db.prepare("SELECT subscription_id FROM subscription_events ORDER BY subscription_id").all() as Array<{
    subscription_id: string;
  }>;
  const remainingSnapshots = db.prepare("SELECT date FROM daily_snapshots ORDER BY date").all() as Array<{ date: string }>;

  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(plainRows(remainingTransactions), [{ id: "tx_recent" }]);
  assert.deepStrictEqual(plainRows(remainingEvents), [{ subscription_id: "sub_recent" }]);
  assert.deepStrictEqual(plainRows(remainingSnapshots), [{ date: recentDate }]);
});

test("getKv and setKv roundtrip values", (t) => {
  const { db } = createTestDb(t);

  assert.strictEqual(getKv(db, "cursor"), null);

  setKv(db, "cursor", "page_1");
  assert.strictEqual(getKv(db, "cursor"), "page_1");

  setKv(db, "cursor", "page_2");
  assert.strictEqual(getKv(db, "cursor"), "page_2");
});
