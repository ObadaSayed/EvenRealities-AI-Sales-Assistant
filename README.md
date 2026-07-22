# Salesforce × Even Realities G2 — AI Sales Assistant

An AI-powered sales assistant running on **Even Realities G2 smart glasses**.  
Browse Salesforce accounts, view live pipeline and AI talking points, and run real-time meeting sessions — all on the glasses display.

| 📄 [Architecture & test script](LIVE_MEETING_COMPANION.md) | 🗺️ [How it works (flow diagram)](FLOW.md) |
|:---|:---|

---

## What it does

- **Account browser** — scroll through your Salesforce accounts on the glasses
- **Account detail** — pipeline chart, contacts, last interaction, AI talking points
- **Live meeting mode** — double-tap an account to start a meeting:
  - Mic captures your conversation every 5 seconds
  - OpenAI Whisper transcribes speech in real time
  - GPT-4o-mini generates 2–3 live cues grounded in what was just said
  - Single-tap to end → AI summary + action items saved to Salesforce automatically

---

## Quick start

### Prerequisites

Install these once on your machine:

```bash
# Node 20+
node -v

# Salesforce CLI
npm install -g @salesforce/cli
sf org login web --alias evenTest

# Even Hub CLI + simulator
npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
```

You'll also need an **OpenAI API key** (for Whisper + GPT).

---

### Step 1 — Clone and install

```bash
git clone https://github.com/ObadaSayed/EvenRealities-AI-Sales-Assistant.git
cd EvenRealities-AI-Sales-Assistant

# Install proxy dependencies
cd proxy && npm install && cd ..

# Install app dependencies
cd app && npm install && cd ..
```

---

### Step 2 — Configure the proxy

```bash
cd proxy
cp .env.example .env
```

Open `proxy/.env` and fill in:

```
OPENAI_API_KEY=sk-...        # your OpenAI key
SF_TARGET_ORG=evenTest       # your sf CLI org alias
```

Verify the proxy starts and connects:

```bash
set -a && source .env && set +a && node server.js
# → SF->EvenHub proxy listening on :3000

# In a second terminal — should return {"ok":true,"stt":"whisper"}
curl http://localhost:3000/health
```

---

### Step 3A — Run in the simulator (no glasses needed)

Open three terminals:

```bash
# Terminal 1 — proxy (from proxy/ with .env sourced)
cd proxy && set -a && source .env && set +a && node server.js

# Terminal 2 — app dev server
cd app && VITE_PROXY_URL=http://localhost:3000 npm run dev

# Terminal 3 — simulator
evenhub-simulator http://localhost:5173 --automation-port 9898
```

The simulator window opens on your Mac. Use tap/double-tap controls to navigate.

---

### Step 3B — Run on real G2 glasses (QR code)

> Your glasses and Mac must be on the **same WiFi network**.

**1. Find your Mac's local IP:**

```bash
ipconfig getifaddr en0
# e.g. 192.168.1.100
```

**2. Create `app/.env.local`** (this file is git-ignored — never committed):

```
VITE_PROXY_URL=http://<YOUR_IP>:3000
```

**3. Build and pack the app:**

```bash
cd app
npm run build
evenhub pack app.json dist
```

**4. Serve the packed app and generate a QR code:**

```bash
# Start a file server in the app/ directory
python3 -m http.server 8080

# In a new terminal — generates the QR code
evenhub qr -u "http://<YOUR_IP>:8080/app.ehpk"
```

**5. Scan the QR code** with your G2 glasses to sideload and open the app.

> **Every time you restart your Mac**, the proxy needs to be restarted too:
> ```bash
> cd proxy && set -a && source .env && set +a && node server.js
> ```

---

## Test the meeting feature

Once the app is running (simulator or glasses):

1. **Open an account** — tap NovaMind AI Technologies
2. **Start a meeting** — double-tap on the account detail view
3. **Watch the timer tick** — `● REC 00:01`, `00:02`… every second
4. **Speak** — say *"Let's discuss contract renewal and pricing for next quarter"*
5. **Wait 5–7 seconds** — the display briefly shows `● REC ↻` then updates with cues about contract/pricing
6. **Change topic** — say *"The customer is concerned about GDPR compliance"*
7. **Cues shift** — they now lead with data privacy
8. **End the meeting** — single-tap → summary screen → `Saved to Salesforce ✓`

Verify in Salesforce:

```bash
cd salesforce && sf data query --target-org evenTest \
  --query "SELECT Name, Summary__c, Meeting_Date__c FROM Meeting_Note__c ORDER BY CreatedDate DESC LIMIT 1"
```

For the full test script and architecture details see **[LIVE_MEETING_COMPANION.md](LIVE_MEETING_COMPANION.md)**.

---

## Repo layout

```
├── app/                  Even Hub app (TypeScript + Vite)
│   ├── src/main.ts       All UI, audio capture, meeting flush loop
│   └── app.json          App manifest + network whitelist
├── proxy/                Node/Express backend
│   ├── server.js         Entry point — Salesforce auth, OpenAI, routing
│   ├── routes/           meeting.js, prep.js, detail.js
│   ├── lib/meeting/      cues.js, summary.js, record.js, session.js
│   ├── test/             65 unit tests (node --test)
│   └── .env.example      Copy to .env and fill in keys
├── salesforce/           Salesforce metadata (Meeting_Note__c object + perm set)
├── LIVE_MEETING_COMPANION.md   Full architecture + test script
└── FLOW.md               Non-technical flow diagram
```

---

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `OPENAI_API_KEY` | `proxy/.env` | Whisper STT + GPT-4o-mini — **required** |
| `SF_TARGET_ORG` | `proxy/.env` | sf CLI org alias (default: `evenTest`) |
| `VITE_PROXY_URL` | `app/.env.local` | Override proxy URL for LAN / glasses use |
| `SFDX_AUTH_URL` | Heroku config only | Long-lived SF credential for production |

---

## Running tests

```bash
cd proxy && node --test
# 65 tests, 0 failures
```
