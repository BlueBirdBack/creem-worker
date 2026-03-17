/**
 * alerts.ts — Telegram message formatting for Creem store events
 *
 * Pure functions: take data, return strings. No side effects.
 */

import type {
  CreemTransaction,
  CreemCustomer,
  SubscriptionChange,
  ChangeSet,
  SubscriptionStatus,
} from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(cents: number, currency = "USD"): string {
  const sym = currency === "EUR" ? "€" : "$";
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return d.toISOString().slice(0, 10);
}

function statusEmoji(status: SubscriptionStatus): string {
  const map: Record<SubscriptionStatus, string> = {
    active: "✅",
    trialing: "🔬",
    past_due: "🚨",
    paused: "⏸️",
    canceled: "❌",
    expired: "💀",
    // scheduled_cancel is webhook-only, not an API status — handled via canceled
  };
  return map[status] ?? "❓";
}

// ── Individual Event Formatters ──────────────────────────────────────────────

export function fmtNewSale(tx: CreemTransaction): string {
  const product = tx.product?.name ?? "Unknown product";
  const customer = tx.customer?.email ?? "Unknown";
  const type = tx.subscription_id ? "Subscription" : "One-time";
  return [
    `💰 New Sale`,
    `Product: ${product} (${fmtMoney(tx.amount, tx.currency)})`,
    `Customer: ${customer}`,
    `Type: ${type}`,
    `Time: ${fmtTime(tx.created_at)}`,
  ].join("\n");
}

export function fmtSubscriptionChange(change: SubscriptionChange): string {
  const from = `${statusEmoji(change.previousStatus)} ${change.previousStatus}`;
  const to = `${statusEmoji(change.newStatus)} ${change.newStatus}`;
  const header = change.newStatus === "past_due"
    ? "🚨 Payment Failed"
    : change.newStatus === "canceled"
      ? "⚠️ Subscription Canceled"
      : change.newStatus === "active" && change.previousStatus === "paused"
        ? "🎉 Subscription Resumed"
        : change.newStatus === "expired"
          ? "💀 Subscription Expired"
          : "📋 Subscription Changed";

  const lines = [header];
  if (change.customerEmail) lines.push(`Customer: ${change.customerEmail}`);
  if (change.productName) lines.push(`Product: ${change.productName}`);
  lines.push(`Status: ${from} → ${to}`);

  // Actionable hints
  if (change.newStatus === "past_due") {
    lines.push("\nCreem will retry automatically. Consider reaching out if this persists.");
  }

  return lines.join("\n");
}

export function fmtNewCustomer(customer: CreemCustomer): string {
  return [
    `👋 New Customer`,
    `Email: ${customer.email}`,
    customer.name ? `Name: ${customer.name}` : null,
    customer.country ? `Country: ${customer.country}` : null,
    `Joined: ${fmtTime(customer.created_at)}`,
  ].filter(Boolean).join("\n");
}

// ── Aggregate Formatters ─────────────────────────────────────────────────────

export function fmtChangeSet(changes: ChangeSet): string | null {
  const parts: string[] = [];

  // New transactions
  if (changes.newTransactions.length === 1) {
    parts.push(fmtNewSale(changes.newTransactions[0]));
  } else if (changes.newTransactions.length > 1) {
    const total = fmtMoney(changes.totalRevenue);
    parts.push(`💰 ${changes.newTransactions.length} New Sales (${total} total)`);
    for (const tx of changes.newTransactions.slice(0, 5)) {
      const product = tx.product?.name ?? "?";
      const customer = tx.customer?.email ?? "?";
      parts.push(`  • ${product} — ${fmtMoney(tx.amount)} — ${customer}`);
    }
    if (changes.newTransactions.length > 5) {
      parts.push(`  … and ${changes.newTransactions.length - 5} more`);
    }
  }

  // Subscription changes
  for (const sc of changes.subscriptionChanges) {
    parts.push("");
    parts.push(fmtSubscriptionChange(sc));
  }

  // New customers (only if no matching transaction already mentioned them)
  const txEmails = new Set(changes.newTransactions.map(tx => tx.customer?.email).filter(Boolean));
  const newOnly = changes.newCustomers.filter(c => !txEmails.has(c.email));
  for (const c of newOnly.slice(0, 3)) {
    parts.push("");
    parts.push(fmtNewCustomer(c));
  }

  // Churn spike detection
  const cancelCount = changes.subscriptionChanges.filter(
    sc => sc.newStatus === "canceled" || sc.newStatus === "expired"
  ).length;
  if (cancelCount >= 3) {
    parts.push("");
    parts.push(`📉 Churn Alert: ${cancelCount} subscriptions lost in this check. Investigate.`);
  }

  if (parts.length === 0) return null;
  return parts.join("\n").trim();
}

// ── Daily Digest ─────────────────────────────────────────────────────────────

export interface DailyDigestData {
  date: string;
  transactionCount: number;
  revenue: number;         // cents
  newCustomers: number;
  subscriptions: Record<SubscriptionStatus, number>;
  prevSubscriptions: Record<SubscriptionStatus, number>;
  mrr: number;             // cents
  mrrChange: number;       // cents (vs yesterday)
}

export function fmtDailyDigest(data: DailyDigestData): string {
  const lines = [`📊 Creem Daily Digest — ${data.date}`];
  lines.push("");

  // Revenue
  lines.push(`Revenue: ${fmtMoney(data.revenue)} (${data.transactionCount} transactions)`);
  lines.push(`New customers: ${data.newCustomers}`);

  // MRR
  if (data.mrr > 0) {
    const arrow = data.mrrChange > 0 ? "↑" : data.mrrChange < 0 ? "↓" : "→";
    lines.push(`MRR: ${fmtMoney(data.mrr)} ${arrow} ${fmtMoney(Math.abs(data.mrrChange))}`);
  }

  // Subscription health
  lines.push("");
  lines.push("Subscriptions:");
  const statuses: SubscriptionStatus[] = ["active", "trialing", "past_due", "paused", "canceled", "expired"];
  for (const s of statuses) {
    const count = data.subscriptions[s] ?? 0;
    const prev = data.prevSubscriptions[s] ?? 0;
    const delta = count - prev;
    const deltaStr = delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : "";
    if (count > 0 || delta !== 0) {
      lines.push(`  ${statusEmoji(s)} ${s}: ${count}${deltaStr}`);
    }
  }

  // Health warnings
  const pastDue = data.subscriptions.past_due ?? 0;
  if (pastDue > 0) {
    lines.push(`\n⚠️ ${pastDue} subscription${pastDue > 1 ? "s" : ""} past due — revenue at risk`);
  }

  return lines.join("\n");
}

// ── Store Snapshot (for /creem command) ──────────────────────────────────────

export function fmtStoreSnapshot(data: {
  customerCount: number;
  subscriptions: Record<SubscriptionStatus, number>;
  recentTransactions: CreemTransaction[];
  mrr: number;
}): string {
  const lines = ["🏪 Creem Store Status"];
  lines.push("");
  lines.push(`Customers: ${data.customerCount}`);
  lines.push(`MRR: ${fmtMoney(data.mrr)}`);

  const totalSubs = Object.values(data.subscriptions).reduce((a, b) => a + b, 0);
  lines.push(`\nSubscriptions: ${totalSubs}`);
  const statuses: SubscriptionStatus[] = ["active", "trialing", "past_due", "paused"];
  for (const s of statuses) {
    const count = data.subscriptions[s] ?? 0;
    if (count > 0) lines.push(`  ${statusEmoji(s)} ${s}: ${count}`);
  }

  if (data.recentTransactions.length > 0) {
    lines.push("\nRecent sales:");
    for (const tx of data.recentTransactions.slice(0, 5)) {
      const product = tx.product?.name ?? "?";
      lines.push(`  • ${fmtMoney(tx.amount)} — ${product} — ${fmtTime(tx.created_at)}`);
    }
  }

  return lines.join("\n");
}
