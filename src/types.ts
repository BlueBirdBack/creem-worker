/**
 * Creem API types — derived from docs.creem.io/api-reference
 * All prices in cents. 1999 = $19.99
 */

// ── API Objects ──────────────────────────────────────────────────────────────

export interface CreemProduct {
  id: string;
  name: string;
  description?: string;
  price: number;           // cents
  currency: string;
  billing_type: "onetime" | "recurring";
  billing_period?: "every-month" | "every-three-months" | "every-six-months" | "every-year";
  tax_category?: string;
  created_at: string;
  updated_at: string;
}

export interface CreemCustomer {
  id: string;
  email: string;
  name?: string;
  country?: string;
  created_at: string;
  updated_at: string;
}

export interface CreemTransaction {
  id: string;
  amount: number;          // cents
  currency: string;
  status: string;
  product?: CreemProduct;
  customer?: CreemCustomer;
  subscription_id?: string;
  metadata?: Record<string, string>;
  created_at: string;
}

/** Creem subscription statuses — used in state tracking per creem.io/HEARTBEAT.md spec */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "paused"
  | "canceled"
  | "expired"
  | "scheduled_cancel";

/** Statuses that are queryable via /subscriptions/search API */
export type ApiSubscriptionStatus = Exclude<SubscriptionStatus, "scheduled_cancel">;

/** Webhook-only event types that look like statuses but aren't queryable */
export type WebhookEventStatus = SubscriptionStatus | "paid" | "update";

export interface CreemSubscription {
  id: string;
  status: SubscriptionStatus;
  product?: CreemProduct;
  customer?: CreemCustomer;
  current_period_start?: string;
  current_period_end?: string;
  cancel_at_period_end?: boolean;
  created_at: string;
  updated_at: string;
}

// ── Plugin State ─────────────────────────────────────────────────────────────

export interface StoreSnapshot {
  lastCheckAt: string | null;
  lastTransactionId: string | null;
  transactionCount: number;
  customerCount: number;
  subscriptions: Record<SubscriptionStatus, number>;
  knownSubscriptions: Record<string, SubscriptionStatus>;
}

export interface SubscriptionChange {
  subscriptionId: string;
  customerId?: string;
  customerEmail?: string;
  productName?: string;
  previousStatus: SubscriptionStatus;
  newStatus: SubscriptionStatus;
}

export interface ChangeSet {
  newTransactions: CreemTransaction[];
  subscriptionChanges: SubscriptionChange[];
  newCustomers: CreemCustomer[];
  subscriptionCounts: Record<SubscriptionStatus, number>;
  previousCounts: Record<SubscriptionStatus, number>;
  totalRevenue: number;    // cents — sum of new transactions
  timestamp: string;
}

// ── Plugin Config ────────────────────────────────────────────────────────────

export interface CreemWorkerConfig {
  apiKey: string;
  testMode: boolean;
  pollIntervalMs: number;
  alertChatId: string;
  dbPath: string;
  dailyDigestHour: number;
  mrrAlerts: boolean;
  statePath: string;
}

export const DEFAULT_CONFIG: Partial<CreemWorkerConfig> = {
  testMode: false,
  pollIntervalMs: 300_000,       // 5 minutes
  alertChatId: "",
  dbPath: "/opt/creem-worker/creem.db",
  dailyDigestHour: 9,
  mrrAlerts: true,
  statePath: "/opt/creem-worker/state.json",
};

// ── API Response Wrappers ────────────────────────────────────────────────────

export interface CreemPagination {
  total_records: number;
  total_pages: number;
  current_page: number;
  next_page: number | null;
  prev_page: number | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: CreemPagination;
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface CreemStatsSummary {
  totals: {
    totalProducts: number;
    totalSubscriptions: number;
    totalCustomers: number;
    totalRevenue: number;       // cents
    totalNetRevenue: number;    // cents
    totalPayments: number;
    activeSubscriptions: number;
    netMonthlyRecurringRevenue: number;   // cents
    monthlyRecurringRevenue: number;      // cents
  };
  periods?: Array<{
    startDate: string;
    endDate: string;
    grossRevenue: number;
    netRevenue: number;
  }>;
}
