/**
 * commands.ts — /creem-* slash command handlers
 *
 * Each function returns { text: string } for OpenClaw to render.
 */

import { DatabaseSync } from "node:sqlite";
import { CreemClient } from "./api.ts";
import { loadState } from "./monitor.ts";
import { calculateMRR } from "./monitor.ts";
import {
  fmtStoreSnapshot,
  fmtDailyDigest,
  type DailyDigestData,
} from "./alerts.ts";
import type { SubscriptionStatus, CreemStatsSummary } from "./types.ts";
import { getDayRevenue, getRevenueRange, getRecentSnapshots } from "./db.ts";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── /creem — Store snapshot ──────────────────────────────────────────────────

export async function handleCreem(
  client: CreemClient,
  statePath: string,
): Promise<{ text: string }> {
  const state = loadState(statePath);

  let mrr = 0;
  let recentTx: any[] = [];

  // Use stats/summary for MRR (1 call vs 7)
  try {
    const stats = await client.getStatsSummary();
    mrr = stats.totals.monthlyRecurringRevenue ?? 0;
  } catch {
    try {
      const allSubs = await client.getAllSubscriptions();
      mrr = calculateMRR(allSubs);
    } catch { /* use 0 */ }
  }

  try {
    const txResp = await client.getTransactions({ pageSize: 5 });
    recentTx = txResp.items ?? [];
  } catch { /* empty */ }

  return {
    text: fmtStoreSnapshot({
      customerCount: state.customerCount,
      subscriptions: state.subscriptions,
      recentTransactions: recentTx,
      mrr,
    }),
  };
}

// ── /creem-stats [period] — Revenue stats ────────────────────────────────────

export function handleCreemStats(
  db: DatabaseSync,
  args: string,
): { text: string } {
  const period = (args || "today").trim().toLowerCase();

  if (period === "today") {
    const day = getDayRevenue(db, todayStr());
    return {
      text: [
        `📈 Today's Revenue`,
        `Transactions: ${day.count}`,
        `Revenue: ${fmtMoney(day.cents)}`,
      ].join("\n"),
    };
  }

  if (period === "week") {
    const rows = getRevenueRange(db, daysAgo(6), todayStr());
    if (rows.length === 0) return { text: "No transaction data yet." };
    let total = 0;
    const lines = ["📅 Last 7 Days"];
    for (const r of rows) {
      lines.push(`${r.date}: ${fmtMoney(r.cents)} (${r.count} tx)`);
      total += r.cents;
    }
    lines.push(`\nTotal: ${fmtMoney(total)}`);
    return { text: lines.join("\n") };
  }

  if (period === "month") {
    const rows = getRevenueRange(db, daysAgo(29), todayStr());
    if (rows.length === 0) return { text: "No transaction data yet." };
    let total = 0;
    const lines = ["📅 Last 30 Days"];
    for (const r of rows) {
      total += r.cents;
    }
    lines.push(`Days with sales: ${rows.length}`);
    lines.push(`Total revenue: ${fmtMoney(total)}`);
    lines.push(`Daily average: ${fmtMoney(Math.round(total / 30))}`);
    return { text: lines.join("\n") };
  }

  return { text: "Usage: /creem-stats [today|week|month]" };
}

// ── /creem-health — Subscription health check ────────────────────────────────

export async function handleCreemHealth(
  client: CreemClient,
): Promise<{ text: string }> {
  try {
    // Try stats/summary first for top-level numbers
    let mrr = 0;
    let totalSubs = 0;
    let activeSubs = 0;

    try {
      const stats = await client.getStatsSummary();
      mrr = stats.totals.monthlyRecurringRevenue ?? 0;
      totalSubs = stats.totals.totalSubscriptions ?? 0;
      activeSubs = stats.totals.activeSubscriptions ?? 0;
    } catch { /* fall through to manual */ }

    // Still need per-status breakdown for health details
    const allSubs = await client.getAllSubscriptions();
    if (!mrr) mrr = calculateMRR(allSubs);
    const total = totalSubs || Object.values(allSubs).reduce((sum, arr) => sum + arr.length, 0);
    const active = activeSubs || (allSubs.active?.length ?? 0);
    const pastDue = allSubs.past_due?.length ?? 0;
    const churnRisk = pastDue;  // scheduled_cancel is webhook-only, tracked via canceled status

    const healthScore = total > 0
      ? Math.round(((active + (allSubs.trialing?.length ?? 0)) / total) * 100)
      : 100;

    const emoji = healthScore >= 90 ? "💚" : healthScore >= 70 ? "💛" : "🔴";

    const lines = [
      `${emoji} Subscription Health: ${healthScore}%`,
      "",
      `MRR: ${fmtMoney(mrr)}`,
      `Total subscriptions: ${total}`,
      `Active: ${active}`,
      `Trialing: ${allSubs.trialing?.length ?? 0}`,
    ];

    if (pastDue > 0) {
      lines.push(`\n🚨 Past due: ${pastDue}`);
      for (const sub of allSubs.past_due.slice(0, 3)) {
        lines.push(`  • ${sub.customer?.email ?? sub.id} — ${sub.product?.name ?? "?"}`);
      }
    }

    if (churnRisk > 0) {
      lines.push(`\n⚠️ Churn risk: ${churnRisk} subscriptions`);
    }

    if (allSubs.paused?.length) {
      lines.push(`⏸️ Paused: ${allSubs.paused.length}`);
    }

    return { text: lines.join("\n") };
  } catch (e: any) {
    return { text: `❌ Failed to check health: ${e.message}` };
  }
}

// ── /creem-revenue — MRR/ARR breakdown ───────────────────────────────────────

export async function handleCreemRevenue(
  client: CreemClient,
  db: DatabaseSync,
): Promise<{ text: string }> {
  try {
    let mrr = 0;
    try {
      const stats = await client.getStatsSummary();
      mrr = stats.totals.monthlyRecurringRevenue ?? 0;
    } catch {
      const allSubs = await client.getAllSubscriptions();
      mrr = calculateMRR(allSubs);
    }
    const arr = mrr * 12;

    const today = getDayRevenue(db, todayStr());
    const weekRows = getRevenueRange(db, daysAgo(6), todayStr());
    const weekTotal = weekRows.reduce((sum, r) => sum + r.cents, 0);

    const lines = [
      `💵 Revenue Overview`,
      "",
      `MRR: ${fmtMoney(mrr)}`,
      `ARR: ${fmtMoney(arr)}`,
      "",
      `Today: ${fmtMoney(today.cents)} (${today.count} tx)`,
      `This week: ${fmtMoney(weekTotal)} (${weekRows.reduce((s, r) => s + r.count, 0)} tx)`,
    ];

    // MRR trend from snapshots
    const snapshots = getRecentSnapshots(db, 7);
    if (snapshots.length >= 2) {
      const latest = snapshots[0]?.mrr_cents ?? 0;
      const oldest = snapshots[snapshots.length - 1]?.mrr_cents ?? 0;
      const mrrDelta = latest - oldest;
      if (mrrDelta !== 0) {
        const arrow = mrrDelta > 0 ? "📈" : "📉";
        lines.push(`\n${arrow} MRR trend (7d): ${mrrDelta > 0 ? "+" : ""}${fmtMoney(mrrDelta)}`);
      }
    }

    return { text: lines.join("\n") };
  } catch (e: any) {
    return { text: `❌ Failed to get revenue: ${e.message}` };
  }
}
