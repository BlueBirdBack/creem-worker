# creem-worker

**Your Creem store never sleeps. Neither should your monitoring.**

An autonomous store monitor — built for OpenClaw, by OpenClaw. Two AI agents designed, coded, and reviewed every line through their own messaging protocol. No human wrote the code. [The story →](#how-it-was-built)

Smart alerts. MRR tracking. Revenue analytics. All in Telegram.

## What it does

Drop this plugin into your OpenClaw instance and it becomes a 24/7 operations employee for your [Creem](https://creem.io) store:

- **💰 Sale alerts** — instant Telegram notification when someone buys
- **⚠️ Churn alerts** — cancellations, scheduled cancels, expirations
- **🚨 Payment failures** — past_due subscriptions flagged immediately
- **👋 New customers** — welcome notifications
- **📉 Churn spike detection** — ≥3 cancellations in one check triggers alarm
- **📊 Daily digest** — revenue, MRR, subscription health at a glance
- **📈 MRR tracking** — native integration with Creem's stats API
- **🔔 Webhooks** — real-time HMAC-verified event processing (optional)

### Slash Commands

| Command | Description |
|---------|-------------|
| `/creem` | Store snapshot — customers, subscriptions, recent sales, MRR |
| `/creem-stats [today\|week\|month]` | Revenue stats by period |
| `/creem-health` | Subscription health score with churn risk analysis |
| `/creem-revenue` | MRR, ARR, and 7-day trends |

### Architecture

```
Creem API ←── polling (configurable) ──→ creem-worker plugin
    ↑                                          │
    │                                  ┌───────┼───────┐
 webhooks                             ▼       ▼       ▼
 (optional)                     state.json  SQLite  Telegram
                                (snapshot)  (history) (alerts)
```

## Quick Start

### 1. Copy to extensions

```bash
git clone https://github.com/BlueBirdBack/creem-worker.git
cp -r creem-worker ~/.openclaw/extensions/creem-worker
```

### 2. Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "creem-worker": {
        "enabled": true,
        "config": {
          "apiKey": "creem_YOUR_API_KEY",
          "testMode": true,
          "alertChatId": "YOUR_TELEGRAM_CHAT_ID"
        }
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

That's it. You'll start seeing alerts in Telegram within 5 minutes.

### 4. (Optional) Enable Webhooks

For real-time alerts instead of polling:

1. Get your webhook secret from [Creem Dashboard → Developers → Webhook](https://creem.io/dashboard/developers)
2. Add to config:
```json
{
  "webhookSecret": "your_webhook_secret",
  "webhookPort": 9444
}
```
3. Register `https://your-domain:9444/webhook/creem` in the Creem dashboard

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKey` | string | *required* | Creem API key (`creem_` for prod, `creem_test_` for sandbox) |
| `testMode` | boolean | `false` | Use test API (`test-api.creem.io`) |
| `pollIntervalMs` | number | `300000` | Polling interval (ms). Default: 5 minutes |
| `alertChatId` | string | — | Telegram chat ID for alerts |
| `dbPath` | string | `/opt/creem-worker/creem.db` | SQLite database path |
| `statePath` | string | `/opt/creem-worker/state.json` | Snapshot state file |
| `dailyDigestHour` | number | `9` | Hour (0-23) for daily digest |
| `mrrAlerts` | boolean | `true` | Enable MRR change alerts |
| `webhookSecret` | string | — | Creem webhook HMAC secret. If empty, webhook disabled |
| `webhookPort` | number | `9444` | Webhook listener port |
| `webhookPath` | string | `/webhook/creem` | Webhook URL path |

## Zero Dependencies

No `npm install`. No `node_modules`. Pure Node.js:

- `node:sqlite` (Node ≥22.5) for history
- `node:http` for webhooks
- `node:crypto` for HMAC verification
- Global `fetch()` for API calls

## Files

```
creem-worker/
├── index.ts                 — Plugin entry: services, commands, RPC
├── openclaw.plugin.json     — Plugin manifest
├── src/
│   ├── api.ts               — Creem REST client (zero deps)
│   ├── monitor.ts           — State diffing + MRR calculation
│   ├── alerts.ts            — Telegram message formatting
│   ├── webhook.ts           — HMAC-verified webhook handler
│   ├── commands.ts          — /creem-* slash commands
│   ├── db.ts                — SQLite schema + queries
│   └── types.ts             — TypeScript types
├── DESIGN.md                — Architecture decisions
└── README.md                — You are here
```

## How It Was Built

This plugin was built by **two AI agents coordinating over a messaging protocol** — no Telegram, no human relay, no copy-pasting code:

1. **B3** (the human) found the [Creem Scoops challenge](https://creem.io/scoops) and shared it with the team. **Ash** designed the architecture and built the plugin skeleton, alert formatting, slash commands, and SQLite storage.

2. **Ash sent the API client and monitor specs to Six** via a direct agent-to-agent message — containing the requirements, endpoint specs, and type definitions.

3. **Six** (running on a separate server) received the task, built `api.ts`, `monitor.ts`, and `webhook.ts`, then published the completed modules back to Ash's inbox.

4. **Ash** pulled Six's code, reviewed it, found and fixed bugs (wrong pagination params), and integrated everything into the final plugin.

Each coordination loop took ~12 minutes. Three AI agents running on separate OpenClaw gateways, each with their own context and judgment, coordinating as colleagues.

## RPC Methods

For scripting and automation:

| Method | Returns |
|--------|---------|
| `creem.status` | Store snapshot with MRR |
| `creem.transactions` | Recent transactions |
| `creem.subscriptions` | Subscription counts + MRR |
| `creem.health` | API health check |

## Requirements

- OpenClaw ≥ 2026.3.13
- Node.js ≥ 22.5 (for `node:sqlite`)
- Creem account with API key

## Architecture Deep Dive

`creem-worker` is built around a simple loop: poll Creem, detect changes, save history, send alerts. The pieces are kept separate so the worker stays quiet and reliable: polling fetches the latest snapshot, diffing decides whether anything meaningful changed, SQLite preserves history, and Telegram only receives messages when something worth interrupting you for actually happened.

Here is the full data flow:

```text
                    +----------------------+
                    |      Creem API       |
                    | tx / subs / custs    |
                    +----------+-----------+
                               |
                               | scheduled fetch
                               v
                    +----------------------+
                    |    polling loop      |
                    |  index.ts -> poll()  |
                    +----------+-----------+
                               |
                               | raw store data
                               v
                    +----------------------+
                    |    state diffing     |
                    |   src/monitor.ts     |
                    +---+--------------+---+
                        |              |
         new snapshot   |              | detected changes
                        |              |
                        v              v
              +----------------+   +----------------+
              |   state.json   |   |    SQLite      |
              | last seen ids  |   | tx + events +  |
              | counts/status  |   | daily snapshots|
              +----------------+   +--------+-------+
                                            |
                                            | alert text + analytics
                                            v
                                   +------------------+
                                   | Telegram alerts  |
                                   | sales / churn /  |
                                   | digest / health  |
                                   +------------------+

Webhooks (optional) flow in parallel:
Creem webhook -> HMAC verification -> event formatting -> SQLite logging -> Telegram alert
```

The polling loop is the safety net. Every `pollIntervalMs` milliseconds, the worker asks Creem for transactions, subscriptions, customers, and MRR-related stats. The diffing layer in `src/monitor.ts` compares that fresh snapshot with the previous one stored in `state.json`, looking for unseen transactions, subscription status transitions, and net customer growth.

SQLite is the long-term memory. JSON state is useful for fast comparisons, but the worker also writes transactions, subscription events, and daily snapshots into SQLite so slash commands and RPC methods can answer questions about revenue windows, MRR movement, and store health.

The heartbeat pattern is central to that design. Rather than treating every poll as a full report, the worker treats each pass as a heartbeat: fetch the latest state, compare it against the last known durable state, emit only meaningful differences, then persist the new baseline.

Webhooks complement polling rather than replacing it. When enabled, `src/webhook.ts` verifies the Creem signature with HMAC-SHA256, acknowledges the event immediately, and then processes the payload asynchronously. That gives you near-real-time notifications for checkout completion, payment failures, cancellations, refunds, and disputes. Polling still matters because it catches anything outside the webhook path and keeps periodic snapshots consistent. In other words: webhooks are the fast lane, polling is the source of resilience.

## Natural Language Queries

`creem-worker` is not limited to fixed slash commands. It also exposes store context in a format that OpenClaw's agent layer can consume, which means you can ask plain-English questions about your business and let the conversational interface do the routing.

Typical questions look like:

- "how much revenue this week?"
- "any failed payments?"
- "who are my customers?"
- "what changed since the last check?"
- "how many subscriptions are past due?"
- "what products are generating recurring revenue?"

This works through OpenClaw's conversational interface. Under the hood, the plugin registers gateway methods such as `creem.status`, `creem.transactions`, `creem.subscriptions`, `creem.health`, and `creem.query`. It also publishes agent context so the model already knows the basic shape of your store: customer count, revenue totals, MRR, active subscriptions, and the last successful check time.

That combination is what makes natural-language querying practical. The model is answering from live plugin methods and fresh state gathered from Creem and SQLite. For a store owner, that means less remembering command names and more talking to the system the same way you would talk to a human operator:

- Ask for a summary and get a status overview.
- Ask about failed payments and get past-due subscription context.
- Ask who your customers are and get recent customer records.
- Ask about revenue and get either live totals or historical rollups.

Slash commands remain useful when you want deterministic output. Natural language is better when the question is ad hoc, multi-part, or exploratory. Both surfaces sit on top of the same worker state, so you can move between `/creem-revenue` and a conversational question without switching tools or duplicating logic.

## Customization Guide

The defaults are intentionally conservative, but the worker is easy to adapt.

To change the polling interval, edit `pollIntervalMs` in your `openclaw.json` plugin config. The default is `300000` milliseconds, which is five minutes. Lower it if you want tighter polling coverage, or raise it if your store is low volume and you want fewer API calls. Because webhook support exists, a common production setup is moderate polling plus webhooks for low-latency events.

To add custom alert rules, start with `src/monitor.ts` and `src/alerts.ts`. `checkForChanges()` already returns a normalized `ChangeSet` with new transactions, subscription transitions, new customers, previous counts, and revenue totals. The simplest pattern is to add another conditional in `fmtChangeSet()` or in the `poll()` flow in `index.ts`. Examples include:

- alert when MRR drops more than a threshold in one day
- alert when refunds exceed a count
- alert when a specific product sells
- alert when customer growth stalls for several days

Because the worker stores history in SQLite, more advanced rules can query recent rows instead of relying only on the current diff.

To switch notification channels, treat Telegram as the default transport, not a hard architectural limit. Today the delivery helper is `tgAlert()` in `index.ts`, and the text formatting lives in `src/alerts.ts` and `src/webhook.ts`. To support Slack or Discord, keep the monitoring and persistence layers as they are and replace only the sender function plus any channel-specific formatting. The minimal migration path is:

1. Keep polling, diffing, state, and SQLite unchanged.
2. Swap `tgAlert()` for a Slack webhook sender or Discord webhook sender.
3. Adjust message formatting if the target channel supports markdown blocks, embeds, or richer attachments.
4. Update plugin configuration with the new channel credentials.

To adjust the daily digest schedule, change `dailyDigestHour` in config. The worker checks the current hour and sends the digest once per day after that threshold, recording the last sent date in SQLite so it does not double-send. If you want more complex schedules, the existing hook point is `maybeSendDigest()` in `index.ts`. That is where you would add timezone-aware logic, weekday-only digests, or multiple summary windows.

## Heartbeat Pattern

The worker follows the same basic heartbeat philosophy described by Creem's official heartbeat pattern: poll on a predictable interval, persist state durably, detect deltas relative to the last pulse, and stay quiet when nothing meaningful changed.

In this implementation, the heartbeat state lives in `state.json`. That file stores the last successful check timestamp, the last seen transaction ID, total customer count, subscription counts, and a map of known subscription statuses. On startup, the worker reads that file, merges it with an empty default snapshot if needed, and uses it as the baseline for the next heartbeat.

Change detection happens in three layers:

- New transactions are identified by comparing the current transaction list to the last seen transaction marker.
- Subscription changes are identified by comparing each known subscription's previous status to its newly fetched status.
- Customer growth is identified by comparing the current total customer count with the last stored count.

Those deltas are then turned into actionable notifications. A single new sale becomes a detailed sale alert. Multiple sales collapse into one grouped alert. Status changes such as `past_due`, `canceled`, or `expired` are elevated because they imply churn risk or payment risk. A burst of cancellations triggers a churn spike warning. If no meaningful delta exists, the worker sends nothing.

That silence is a feature, not an absence of work. A healthy heartbeat loop should prove the system is watching without forcing humans to read "still nothing happened" messages all day. The worker keeps state fresh, updates daily snapshots, and remains ready for the next meaningful transition.

Webhooks fit this heartbeat model cleanly. They accelerate event arrival, but they do not change the core principle. Polling still establishes the durable baseline, JSON still stores the last known state, SQLite still keeps the audit trail, and alerts still depend on meaningful changes rather than raw noise.

## License

MIT — Built for OpenClaw, by OpenClaw. Ash 🌿 & Six ⚡

---

*Submitted for [Creem Scoops](https://creem.io/scoops) — OpenClaw + CREEM AI Agent Worker challenge*
