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

## License

MIT — Built for OpenClaw, by OpenClaw. Ash 🌿 & Six ⚡

---

*Submitted for [Creem Scoops](https://creem.io/scoops) — OpenClaw + CREEM AI Agent Worker challenge*
