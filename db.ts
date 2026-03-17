/**
 * db.ts — SQLite storage for Creem transaction history and analytics
 *
 * Zero deps — uses node:sqlite (Node ≥22.5)
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Schema ───────────────────────────────────────────────────────────────────

export function setupDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      ts          INTEGER NOT NULL,
      date        TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      currency    TEXT DEFAULT 'USD',
      status      TEXT,
      product_id  TEXT,
      product_name TEXT,
      customer_id TEXT,
      customer_email TEXT,
      subscription_id TEXT,
      is_recurring INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subscription_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      date        TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      customer_email TEXT,
      product_name TEXT,
      old_status  TEXT,
      new_status  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_snapshots (
      date            TEXT PRIMARY KEY,
      customer_count  INTEGER DEFAULT 0,
      active_subs     INTEGER DEFAULT 0,
      trialing_subs   INTEGER DEFAULT 0,
      past_due_subs   INTEGER DEFAULT 0,
      paused_subs     INTEGER DEFAULT 0,
      canceled_subs   INTEGER DEFAULT 0,
      expired_subs    INTEGER DEFAULT 0,
      scheduled_cancel_subs INTEGER DEFAULT 0,
      revenue_cents   INTEGER DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      mrr_cents       INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_sub_events_date ON subscription_events(date);
  `);

  return db;
}

// ── Transaction Logging ──────────────────────────────────────────────────────

export function logTransaction(db: DatabaseSync, tx: {
  id: string;
  amount: number;
  currency: string;
  status: string;
  productId?: string;
  productName?: string;
  customerId?: string;
  customerEmail?: string;
  subscriptionId?: string;
  createdAt?: string;  // ISO timestamp from API/webhook — use for accurate date attribution
}): void {
  const ts = tx.createdAt ? new Date(tx.createdAt).getTime() : Date.now();
  const now = isNaN(ts) ? Date.now() : ts;
  const date = new Date(now).toISOString().slice(0, 10);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO transactions
        (id, ts, date, amount, currency, status, product_id, product_name,
         customer_id, customer_email, subscription_id, is_recurring)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx.id, now, date, tx.amount, tx.currency, tx.status,
      tx.productId ?? null, tx.productName ?? null,
      tx.customerId ?? null, tx.customerEmail ?? null,
      tx.subscriptionId ?? null, tx.subscriptionId ? 1 : 0,
    );
  } catch { /* dedup via PRIMARY KEY */ }
}

export function logSubscriptionEvent(db: DatabaseSync, event: {
  subscriptionId: string;
  customerEmail?: string;
  productName?: string;
  oldStatus: string;
  newStatus: string;
}): void {
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO subscription_events
      (ts, date, subscription_id, customer_email, product_name, old_status, new_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(now, date, event.subscriptionId, event.customerEmail ?? null,
    event.productName ?? null, event.oldStatus, event.newStatus);
}

// ── Daily Snapshot ───────────────────────────────────────────────────────────

export function saveDailySnapshot(db: DatabaseSync, data: {
  date: string;
  customerCount: number;
  subscriptions: Record<string, number>;
  revenueCents: number;
  transactionCount: number;
  mrrCents: number;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots
      (date, customer_count, active_subs, trialing_subs, past_due_subs,
       paused_subs, canceled_subs, expired_subs, scheduled_cancel_subs,
       revenue_cents, transaction_count, mrr_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.date, data.customerCount,
    data.subscriptions.active ?? 0,
    data.subscriptions.trialing ?? 0,
    data.subscriptions.past_due ?? 0,
    data.subscriptions.paused ?? 0,
    data.subscriptions.canceled ?? 0,
    data.subscriptions.expired ?? 0,
    data.subscriptions.scheduled_cancel ?? 0,
    data.revenueCents, data.transactionCount, data.mrrCents,
  );
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function getDayRevenue(db: DatabaseSync, date: string): { count: number; cents: number } {
  const row = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as cents
    FROM transactions WHERE date = ?
  `).get(date) as any;
  return { count: row?.count ?? 0, cents: row?.cents ?? 0 };
}

export function getRevenueRange(db: DatabaseSync, startDate: string, endDate: string): {
  date: string; count: number; cents: number;
}[] {
  return db.prepare(`
    SELECT date, COUNT(*) as count, SUM(amount) as cents
    FROM transactions
    WHERE date >= ? AND date <= ?
    GROUP BY date
    ORDER BY date DESC
  `).all(startDate, endDate) as any[];
}

export function getRecentSnapshots(db: DatabaseSync, days: number): any[] {
  return db.prepare(`
    SELECT * FROM daily_snapshots
    WHERE date >= date('now', '-' || ? || ' days')
    ORDER BY date DESC
  `).all(days) as any[];
}

export function getKv(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function cleanupOldData(db: DatabaseSync, retainDays = 180): number {
  const r1 = db.prepare("DELETE FROM transactions WHERE date < date('now', '-' || ? || ' days')").run(retainDays) as any;
  const r2 = db.prepare("DELETE FROM subscription_events WHERE date < date('now', '-' || ? || ' days')").run(retainDays) as any;
  const r3 = db.prepare("DELETE FROM daily_snapshots WHERE date < date('now', '-' || ? || ' days')").run(retainDays) as any;
  return (r1.changes ?? 0) + (r2.changes ?? 0) + (r3.changes ?? 0);
}
