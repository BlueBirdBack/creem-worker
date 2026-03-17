/**
 * monitor.ts — Store state diffing engine
 *
 * Loads previous snapshot, fetches current state from Creem,
 * computes changes, returns a ChangeSet.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CreemClient } from "./api.ts";
import type {
  StoreSnapshot,
  ChangeSet,
  SubscriptionChange,
  SubscriptionStatus,
  CreemTransaction,
  CreemCustomer,
  CreemSubscription,
} from "./types.ts";

// ── Default empty snapshot ───────────────────────────────────────────────────

const EMPTY_SUBS: Record<SubscriptionStatus, number> = {
  active: 0, trialing: 0, past_due: 0, paused: 0,
  canceled: 0, expired: 0, scheduled_cancel: 0,
};

function emptySnapshot(): StoreSnapshot {
  return {
    lastCheckAt: null,
    lastTransactionId: null,
    transactionCount: 0,
    customerCount: 0,
    subscriptions: { ...EMPTY_SUBS },
    knownSubscriptions: {},
  };
}

// ── State persistence ────────────────────────────────────────────────────────

export function loadState(path: string): StoreSnapshot {
  try {
    const raw = readFileSync(path, "utf-8");
    return { ...emptySnapshot(), ...JSON.parse(raw) };
  } catch {
    return emptySnapshot();
  }
}

export function saveState(path: string, state: StoreSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── Core diffing ─────────────────────────────────────────────────────────────

export async function checkForChanges(
  client: CreemClient,
  statePath: string,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ changes: ChangeSet; newState: StoreSnapshot }> {
  const prev = loadState(statePath);
  const log = logger ?? { info: () => {}, warn: () => {} };

  // ── Fetch current state ─────────────────────────────────────────────────

  let transactions: CreemTransaction[] = [];
  let allSubs: Record<SubscriptionStatus, CreemSubscription[]>;
  let customers: CreemCustomer[] = [];
  let customerTotalCount = 0;

  try {
    transactions = await client.getAllTransactions();
  } catch (e: any) {
    log.warn(`creem-worker: failed to fetch transactions: ${e.message}`);
  }

  try {
    allSubs = await client.getAllSubscriptions();
  } catch (e: any) {
    log.warn(`creem-worker: failed to fetch subscriptions: ${e.message}`);
    allSubs = Object.fromEntries(
      (["active", "trialing", "past_due", "paused", "canceled", "expired"] as SubscriptionStatus[])
        .map(s => [s, []])
    ) as Record<SubscriptionStatus, CreemSubscription[]>;
  }

  try {
    const custResult = await client.getAllCustomers();
    customers = custResult.items;
    customerTotalCount = custResult.totalCount;
  } catch (e: any) {
    log.warn(`creem-worker: failed to fetch customers: ${e.message}`);
  }

  // ── Diff transactions ───────────────────────────────────────────────────

  const knownTxIds = new Set<string>();
  if (prev.lastTransactionId) {
    // All transactions up to and including the last known one are "old"
    let found = false;
    for (const tx of transactions) {
      if (tx.id === prev.lastTransactionId) { found = true; }
      if (found) knownTxIds.add(tx.id);
    }
    // If we didn't find the marker, treat everything as potentially new
    // (could happen if more than 50 new tx since last check)
  }

  const newTransactions = prev.lastTransactionId
    ? transactions.filter(tx => !knownTxIds.has(tx.id))
    : [];  // First run: don't alert on everything

  const totalRevenue = newTransactions.reduce((sum, tx) => sum + (tx.amount ?? 0), 0);

  // ── Diff subscriptions ──────────────────────────────────────────────────

  const subscriptionCounts = { ...EMPTY_SUBS };
  const currentKnownSubs: Record<string, SubscriptionStatus> = {};
  const subscriptionChanges: SubscriptionChange[] = [];

  for (const [status, subs] of Object.entries(allSubs)) {
    subscriptionCounts[status as SubscriptionStatus] = subs.length;
    for (const sub of subs) {
      currentKnownSubs[sub.id] = status as SubscriptionStatus;
      const prevStatus = prev.knownSubscriptions[sub.id];
      if (prevStatus && prevStatus !== status) {
        subscriptionChanges.push({
          subscriptionId: sub.id,
          customerId: sub.customer?.id,
          customerEmail: sub.customer?.email,
          productName: sub.product?.name,
          previousStatus: prevStatus,
          newStatus: status as SubscriptionStatus,
        });
      }
    }
  }

  // ── Diff customers ──────────────────────────────────────────────────────

  const newCustomers = prev.customerCount > 0 && customerTotalCount > prev.customerCount
    ? customers.slice(0, customerTotalCount - prev.customerCount)
    : [];  // First run or no new: empty

  // ── Build new state ─────────────────────────────────────────────────────

  const newState: StoreSnapshot = {
    lastCheckAt: new Date().toISOString(),
    lastTransactionId: transactions[0]?.id ?? prev.lastTransactionId,
    transactionCount: prev.transactionCount + newTransactions.length,
    customerCount: customerTotalCount,
    subscriptions: subscriptionCounts,
    knownSubscriptions: currentKnownSubs,
  };

  const changes: ChangeSet = {
    newTransactions,
    subscriptionChanges,
    newCustomers,
    subscriptionCounts,
    previousCounts: prev.subscriptions,
    totalRevenue,
    timestamp: new Date().toISOString(),
  };

  log.info(
    `creem-worker: check complete — ${newTransactions.length} new tx, ` +
    `${subscriptionChanges.length} sub changes, ${newCustomers.length} new customers`
  );

  return { changes, newState };
}

// ── MRR Calculation ──────────────────────────────────────────────────────────

export function calculateMRR(
  subs: Record<SubscriptionStatus, CreemSubscription[]>,
): number {
  // Only count active + trialing subscriptions toward MRR
  const countable = [...(subs.active ?? []), ...(subs.trialing ?? [])];
  let mrr = 0;

  for (const sub of countable) {
    const price = sub.product?.price ?? 0;
    const period = sub.product?.billing_period;

    switch (period) {
      case "every-month":
        mrr += price;
        break;
      case "every-three-months":
        mrr += Math.round(price / 3);
        break;
      case "every-six-months":
        mrr += Math.round(price / 6);
        break;
      case "every-year":
        mrr += Math.round(price / 12);
        break;
      default:
        // One-time or unknown: don't count toward MRR
        break;
    }
  }

  return mrr;
}
