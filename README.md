# Salesforce × Even Realities G2 — AI Sales Assistant

A Salesforce-connected AI assistant running on Even Realities G2 smart glasses. Browse accounts, view pipeline and talking points, and run AI-powered live meeting sessions — all on the glasses display.

**→ [Live Meeting Companion — architecture, setup & test script](LIVE_MEETING_COMPANION.md)**

Data path:

```
Salesforce org ──> proxy (Node/Express + jsforce) ──> Even Hub app (WebView) ──> G2 display
```

The app shows an **Ask Agentforce (voice)** row plus the 5 most recent Accounts
with a `>` cursor. Interaction:

- Swipe up/down: move the cursor
- Single tap on an account: drill into it — runs an on-demand query for its
  Opportunities and shows the total pipeline sum + open amount + line items
- Single tap on "Ask Agentforce (voice)": start listening (mic on). Ask a
  question ("opportunities for NetAssist"), then tap to send. The audio is
  transcribed and routed to an Agentforce agent (or a SOQL-backed mock when no
  agent is configured); the answer renders on the glasses.
- Single tap (in detail/answer view): back to the list
- Double tap: back to list, or exit the app from the list

### Voice → Agentforce path

```
G2 mic (PCM) ─> proxy /voice ─> STT (Whisper) ─> Agentforce Agent API ─> answer ─> G2 display
                                                   └─ (mock SOQL agent if unconfigured)
```

The simulator captures your Mac's microphone, so the full voice flow can be
exercised without hardware once an STT key is set. Until then, tapping "send"
falls back to a demo question so the agent round-trip is still visible.

## Layout

- `proxy/` — Express + jsforce server exposing `GET /accounts` (CORS enabled).
  Runs locally (auth via the `sf` CLI session) or on Heroku (auth via the
  `SFDX_AUTH_URL` config var). Also deployed at
  `https://sf-evenhub-proxy-4f011c764460.herokuapp.com`.
- `app/` — Vite + TypeScript Even Hub app using `@evenrealities/even_hub_sdk`.

## Prerequisites

- Node 20+ (tested on v24)
- `sf` (Salesforce CLI), `heroku` CLI, `jq`
- Even Hub tooling: `npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator`

## Salesforce auth

```bash
sf org login web --alias evenTest
# smoke test:
sf data query --query "SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 5" \
  --target-org evenTest --json
```

## Run locally

Three terminals:

```bash
# 1) proxy (uses the sf CLI session; needs OPENAI_API_KEY in proxy/.env)
cd proxy && npm install
set -a && source .env && set +a && node server.js   # :3000

# 2) app dev server
cd app && npm install && VITE_PROXY_URL=http://localhost:3000 npm run dev   # :5173

# 3) simulator
evenhub-simulator http://localhost:5173 --automation-port 9898
```

To run on real G2 glasses, see **[LIVE_MEETING_COMPANION.md](LIVE_MEETING_COMPANION.md)**.

Click the simulator display (or `POST /api/input {"action":"click"}` on the
automation port) to load Accounts.

## Deploy to Heroku (Phase 2)

```bash
cd proxy
git init && git add -A && git commit -m "proxy"
heroku create sf-evenhub-proxy
git push heroku HEAD:main

# headless Salesforce auth (reuses your sf login; no Connected App/cert):
heroku config:set SFDX_AUTH_URL="$(sf org display --verbose --target-org evenTest --json \
  | jq -r '.result.sfdxAuthUrl')" -a sf-evenhub-proxy

curl https://sf-evenhub-proxy-4f011c764460.herokuapp.com/accounts
```

The app defaults to the Heroku proxy (see `app/src/main.ts`); the origin is in
`app/app.json` `network.whitelist`. Override locally with `VITE_PROXY_URL`.

## Endpoints

- `GET /health` — `{ ok, authMode }` (`sf-cli` or `sfdx-auth-url`)
- `GET /accounts` — `{ accounts: [{ id, name }] }`
- `GET /accounts/:id/opportunities` — on-demand drill-down for one account:
  `{ account, count, totalAmount, openAmount, opportunities: [{ id, name, amount, stage, isClosed, isWon }] }`
  (account id is validated as 15/18-char alphanumeric)
- `GET /opportunities?account=<name>` — same shape, looked up by account name
  (e.g. "opportunities for NetAssist"); the account name is SOQL-escaped
- `POST /ask` — `{ text }` → `{ source: "agentforce"|"mock", answer }`. Routes a
  natural-language question to the Agentforce agent, or a SOQL-backed mock agent
  when Agentforce env vars are unset.
- `POST /voice` — `{ audioBase64 }` (PCM16 mono 16 kHz) → `{ transcript, source,
  answer }`. Transcribes via Whisper then calls the same agent path. Returns
  `501 stt_not_configured` when no STT key is set.
- `POST /meeting/start` — `{ accountId }` → `{ sessionId, cues }`. Opens a meeting session seeded with the account's prep talking points.
- `POST /meeting/:id/chunk` — `{ audioBase64 }` → `{ transcript, cues }`. Transcribes the audio chunk (Whisper) and regenerates live cues (GPT-4o-mini) grounded in the transcript delta. Silent/noise chunks are skipped without an LLM call.
- `POST /meeting/:id/end` — `{}` → `{ summary, actionItems, nextSteps, recordId, saved }`. Generates a meeting summary and writes a `Meeting_Note__c` to Salesforce.

`GET /health` reports `{ ok, authMode, stt: "whisper"|"disabled", agentConfigured }`.

## Voice + Agentforce config (optional)

All optional — without them the app still works via the mock agent + demo query.

```bash
# Speech-to-text (OpenAI Whisper) — enables real spoken questions:
heroku config:set OPENAI_API_KEY=sk-... -a sf-evenhub-proxy
#   local:  OPENAI_API_KEY=sk-... npm start

# Agentforce Agent API (client-credentials flow; requires a Connected App with
# "client credentials" enabled and an Agentforce agent published in the org):
heroku config:set \
  AGENTFORCE_AGENT_ID=0Xx... \
  AGENTFORCE_DOMAIN=https://your-org.my.salesforce.com \
  AGENTFORCE_CLIENT_ID=... \
  AGENTFORCE_CLIENT_SECRET=... -a sf-evenhub-proxy
```

When the four `AGENTFORCE_*` vars are set the proxy starts a session against
`https://api.salesforce.com/einstein/ai-agent/v1` and forwards the transcript;
otherwise it answers from SOQL locally.

## Notes / next steps

- `SFDX_AUTH_URL` is a long-lived org credential; it lives only in Heroku
  config vars, never in the repo.
- On-device: `evenhub pack app.json dist -o app.ehpk`, then QR-sideload to
  paired G2s (needs hardware; the simulator covers everything else).
- The simulator cannot reproduce IMU, real device-status events, or exact
  firmware fonts — none of which this test uses.
