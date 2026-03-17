# creem-worker — OpenClaw Plugin

## Challenge
"OpenClaw + CREEM AI Agent Worker" — $3,000 Flavor Showdown, deadline Mar 31.
Build an autonomous AI agent running as an OpenClaw worker that monitors a Creem store,
sends alerts via Telegram, and acts as a proactive operations employee.

## Architecture

### Plugin Core (`index.ts`)
- Registers as OpenClaw extension at `~/.openclaw/extensions/creem-worker/`
- Uses OpenClaw plugin SDK: `api.on()`, `api.registerCommand()`, `api.registerService()`

### Data Flow
```
Creem API ←── polling (every 5min) ──→ creem-worker plugin
                                            │
                                    ┌───────┼───────┐
                                    ▼       ▼       ▼
                              state.json  SQLite  Telegram alerts
                              (snapshot)  (history) (via gateway)
```

### Features

#### 1. Store Monitor (Service)
- Polls Creem API every 5 minutes (configurable)
- Tracks: transactions, subscriptions, customers
- State diffing against previous snapshot
- SQLite for historical data

#### 2. Smart Alerts (via Telegram)
- New sale → 💰 amount, product, customer
- Subscription canceled → ⚠️ customer, product, reason
- Payment failed (past_due) → 🚨 customer, product, amount at risk
- New customer → 👋 welcome signal
- Churn spike → 📉 multiple cancellations detected
- Daily digest → 📊 summary of the day

#### 3. Proactive Operations (LLM-powered)
- Analyzes transaction patterns
- Detects anomalies (revenue drop, unusual churn)
- Suggests actions (follow up with churning customer, celebrate milestones)
- MRR tracking and growth alerts

#### 4. Commands
- `/creem` — current store snapshot
- `/creem-stats [period]` — revenue stats (today/week/month)
- `/creem-customers` — top customers
- `/creem-health` — subscription health check
- `/creem-revenue` — MRR/ARR breakdown

#### 5. RPC Methods
- `creem.status` — JSON store state
- `creem.transactions` — recent transactions
- `creem.subscriptions` — subscription breakdown

### Config (openclaw.json)
```json
{
  "creem-worker": {
    "enabled": true,
    "config": {
      "apiKey": "creem_xxx",
      "testMode": false,
      "pollIntervalMs": 300000,
      "alertChatId": "YOUR_CHAT_ID",
      "dbPath": "/opt/creem-worker/creem.db",
      "dailyDigestHour": 9,
      "mrrAlerts": true
    }
  }
}
```

### Files
```
creem-worker/
├── index.ts          — plugin entry, registers everything
├── api.ts            — Creem API client (fetch-based, zero deps)
├── monitor.ts        — polling loop, state diffing
├── alerts.ts         — Telegram message formatting
├── analytics.ts      — MRR calc, churn detection, anomaly detection
├── db.ts             — SQLite schema + queries
├── commands.ts       — /creem-* command handlers
├── types.ts          — TypeScript types for Creem objects
└── README.md         — setup guide, demo screenshots
```

### Work Split
- **Ash**: plugin skeleton, alert formatting, commands, integration testing
- **Six**: Creem API client, state diffing engine, analytics/MRR calculations
- **Coordination**: agent-to-agent messaging
- **Review**: cross-review, merge, deploy

### Zero Dependencies
Like usage-tracker — pure Node.js, `node:sqlite`, `fetch()`. No npm install needed.

### Submission Strategy
1. Working plugin with real test-mode data
2. Demo video: install → first heartbeat → alerts flowing → commands
3. Story angle: "Two AI agents built this via their own messaging protocol"
4. GitHub repo (public) with clean README
5. Content: Twitter thread + video showing the build process
