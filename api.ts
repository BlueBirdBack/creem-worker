/**
 * api.ts — Creem API client
 *
 * Zero dependencies — uses global fetch() (Node ≥18).
 * Auth via x-api-key header.
 */

import type {
  CreemTransaction,
  CreemSubscription,
  CreemCustomer,
  CreemProduct,
  CreemPagination,
  CreemStatsSummary,
  SubscriptionStatus,
} from "./types.ts";

export interface CreemClientOptions {
  apiKey: string;
  testMode?: boolean;
}

export class CreemClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: CreemClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.testMode
      ? "https://test-api.creem.io/v1"
      : "https://api.creem.io/v1";
  }

  // ── Core fetch ───────────────────────────────────────────────────────────

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Creem API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  async getTransactions(opts: { pageNumber?: number; pageSize?: number } = {}): Promise<{
    items: CreemTransaction[];
    pagination: CreemPagination;
  }> {
    const params: Record<string, string> = {};
    if (opts.pageNumber) params.page_number = String(opts.pageNumber);
    if (opts.pageSize) params.page_size = String(opts.pageSize);
    return this.request("/transactions/search", Object.keys(params).length ? params : undefined);
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  async getSubscriptionsByStatus(status: SubscriptionStatus): Promise<{
    items: CreemSubscription[];
    pagination: CreemPagination;
  }> {
    return this.request("/subscriptions/search", { status });
  }

  async getAllSubscriptions(): Promise<Record<SubscriptionStatus, CreemSubscription[]>> {
    // Only query valid API statuses — scheduled_cancel is webhook-only, not a query param
    const statuses: SubscriptionStatus[] = [
      "active", "trialing", "past_due", "paused",
      "canceled", "expired",
    ];

    const results = {} as Record<SubscriptionStatus, CreemSubscription[]>;

    // Serialize to avoid rate limits (6 calls)
    for (const status of statuses) {
      try {
        const resp = await this.getSubscriptionsByStatus(status);
        // Follow pagination to get ALL subscriptions, not just page 1
        let allItems = resp.items ?? [];
        let nextPage = resp.pagination?.next_page;
        while (nextPage) {
          const more = await this.request<{ items: CreemSubscription[]; pagination: CreemPagination }>(
            "/subscriptions/search", { status, page_number: String(nextPage) }
          );
          allItems = allItems.concat(more.items ?? []);
          nextPage = more.pagination?.next_page;
        }
        results[status] = allItems;
      } catch {
        results[status] = [];
      }
    }

    return results;
  }

  // ── Paginated fetch helpers ──────────────────────────────────────────────

  /** Fetch all transactions across all pages */
  async getAllTransactions(): Promise<CreemTransaction[]> {
    let allItems: CreemTransaction[] = [];
    let page = 1;
    while (true) {
      const resp = await this.getTransactions({ pageNumber: page, pageSize: 50 });
      allItems = allItems.concat(resp.items ?? []);
      if (!resp.pagination?.next_page) break;
      page = resp.pagination.next_page;
    }
    return allItems;
  }

  /** Fetch all customers across all pages */
  async getAllCustomers(): Promise<{ items: CreemCustomer[]; totalCount: number }> {
    const first = await this.getCustomers({ pageSize: 50 });
    let allItems = first.items ?? [];
    const totalCount = first.pagination?.total_records ?? allItems.length;
    let nextPage = first.pagination?.next_page;
    while (nextPage) {
      const more = await this.getCustomers({ pageNumber: nextPage, pageSize: 50 });
      allItems = allItems.concat(more.items ?? []);
      nextPage = more.pagination?.next_page;
    }
    return { items: allItems, totalCount };
  }

  // ── Customers ────────────────────────────────────────────────────────────

  async getCustomers(opts: { pageNumber?: number; pageSize?: number } = {}): Promise<{
    items: CreemCustomer[];
    pagination: CreemPagination;
  }> {
    const params: Record<string, string> = {};
    if (opts.pageNumber) params.page_number = String(opts.pageNumber);
    if (opts.pageSize) params.page_size = String(opts.pageSize);
    return this.request("/customers/list", Object.keys(params).length ? params : undefined);
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async getProducts(opts: { pageNumber?: number; pageSize?: number } = {}): Promise<{
    items: CreemProduct[];
    pagination: CreemPagination;
  }> {
    const params: Record<string, string> = {};
    if (opts.pageNumber) params.page_number = String(opts.pageNumber);
    if (opts.pageSize) params.page_size = String(opts.pageSize);
    return this.request("/products/search", Object.keys(params).length ? params : undefined);
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async getStatsSummary(currency = "USD"): Promise<CreemStatsSummary> {
    return this.request("/stats/summary", { currency });
  }

  // ── Health check ─────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.getProducts();
      return true;
    } catch {
      return false;
    }
  }
}
