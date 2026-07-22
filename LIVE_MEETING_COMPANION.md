# Live Meeting Companion

An AI-powered meeting assistant running on Even Realities G2 smart glasses. While you're in a sales call, it listens to the conversation, transcribes speech in real time, and surfaces contextual cues on the glasses display — grounded in both the account's Salesforce prep data and what was just said.

At the end of the meeting, it generates a summary, action items, and next steps, then writes a `Meeting_Note__c` record directly to Salesforce.

---

## How it works

```
G2 mic (PCM16, 16 kHz)
        │  every 5 seconds
        ▼
  proxy /meeting/:id/chunk
        │
        ├─► Whisper (speech-to-text) ──► transcript delta
        │
        └─► GPT-4o-mini
              Inputs:
                - Account prep talking points (from Salesforce Meeting_Prep__c)
                - Accumulated transcript (last 1500 chars)
                - "They just said: …" (the latest 5s of speech)
              Output: 2–3 imperative cue lines
                        │
                        ▼
              Glasses display updates with new cues
```

On meeting end:

```
proxy /meeting/:id/end
        │
        ├─► GPT-4o-mini ──► { summary, actionItems, nextSteps }
        │
        └─► jsforce ──► Meeting_Note__c (Salesforce)
                          - Account__c lookup
                          - Meeting_Prep__c lookup
                          - Transcript, Summary, Action Items, Next Steps
                          - Meeting_Date__c
```

---

## Architecture

### Components

| Component | Path | Purpose |
|---|---|---|
| Proxy | `proxy/server.js` | Express server; Salesforce auth, OpenAI calls, session state |
| Meeting routes | `proxy/routes/meeting.js` | `/meeting/start`, `/:id/chunk`, `/:id/end` |
| Cue engine | `proxy/lib/meeting/cues.js` | Builds GPT prompt with delta injection; parses cue lines |
| Summary engine | `proxy/lib/meeting/summary.js` | Generates structured meeting summary via GPT |
| Salesforce writer | `proxy/lib/meeting/record.js` | Builds and writes `Meeting_Note__c` |
| Session store | `proxy/lib/meeting/session.js` | In-memory Map of active meeting sessions |
| Glasses app | `app/src/main.ts` | All UI logic; audio capture; flush loop; gesture handling |

### Salesforce objects

| Object | Fields |
|---|---|
| `Meeting_Prep__c` | Account lookup, talking points (existing) |
| `Meeting_Note__c` | Account__c, Meeting_Prep__c, Meeting_Date__c, Transcript__c, Summary__c, Action_Items__c, Next_Steps__c |

### Key constants (app)

| Constant | Value | Purpose |
|---|---|---|
| `MEETING_FLUSH_MS` | 5000 ms | How often audio is sent to the proxy for transcription |
| Clock interval | 1000 ms | How often the REC timer re-renders on the glasses |

### Gesture map

| Gesture | View | Action |
|---|---|---|
| Double-tap | Account detail | Start meeting |
| Single-tap | Meeting | End & save |
| Double-tap | Meeting | Discard (no save) |
| Single-tap | Meeting summary | Back to accounts |

### Display states

```
● REC 00:23   NovaMind AI Technologies      ← normal
● REC ↻ 00:23   NovaMind AI Technologies    ← chunk in-flight (Whisper + GPT running)
```

---

## Local setup

### Prerequisites

- Node 20+
- `sf` CLI authenticated: `sf org login web --alias evenTest`
- `evenhub` CLI: `npm i -g @evenrealities/evenhub-cli`
- OpenAI API key (for Whisper + GPT)

### 1. Proxy

```bash
cd proxy
npm install
cp .env.example .env          # fill in OPENAI_API_KEY, SF_TARGET_ORG=evenTest
set -a && source .env && set +a && node server.js
# → listening on :3000
```

Verify:
```bash
curl http://localhost:3000/health
# {"ok":true,"authMode":"sf-cli","stt":"whisper"}
```

### 2. App (simulator)

```bash
cd app
npm install
VITE_PROXY_URL=http://localhost:3000 npm run dev   # :5173
evenhub-simulator http://localhost:5173 --automation-port 9898
```

### 3. App (real glasses via QR)

Find your Mac's LAN IP:
```bash
ipconfig getifaddr en0
# e.g. 192.168.1.232
```

Create `app/.env.local`:
```
VITE_PROXY_URL=http://<YOUR_LAN_IP>:3000
```

Build and pack:
```bash
cd app
npm run build
evenhub pack app.json dist
```

Serve and generate QR:
```bash
# in app/ directory
python3 -m http.server 8080
evenhub qr -u "http://<YOUR_LAN_IP>:8080/app.ehpk"
```

Scan the QR with your G2 glasses (must be on the same WiFi as your Mac).

> **Note:** `app/.env.local` is git-ignored (`*.local`). Each developer sets their own LAN IP there.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Whisper STT + GPT-4o-mini for cues and summary |
| `SF_TARGET_ORG` | No | `sf` CLI org alias (default: `evenTest`) |
| `SFDX_AUTH_URL` | Heroku only | Long-lived Salesforce credential for server deployments |
| `OPENAI_CHAT_MODEL` | No | Override GPT model (default: `gpt-4o-mini`) |

---

## Test script

Run this after setup to verify everything is working end-to-end on the glasses.

### Test 1 — Timer & indicator (no speech, ~30 seconds)

1. Open the accounts list → tap **NovaMind AI Technologies**
2. Double-tap to start the meeting
3. Watch the display without speaking

**Pass criteria:**
- `● REC 00:01`, `00:02`, `00:03` … increments every second
- No `↻` appears (nothing is processing)
- Cues stay unchanged

---

### Test 2 — Dynamic cues (the core feature)

From the active meeting, say:

> *"So I wanted to discuss the contract renewal — we're thinking about pricing for next quarter and whether the current terms still make sense."*

Wait 5–7 seconds.

**Pass criteria:**
- `● REC ↻` appears briefly while the chunk is processing
- Cues update and reference **contract renewal** or **pricing**
- A transcript snippet appears in quotes below the cues

Then say:

> *"Also the customer mentioned they're very concerned about data privacy and GDPR compliance."*

Wait 5–7 seconds.

**Pass criteria:**
- Cues shift to lead with **data privacy** or **GDPR**
- The previous cues about pricing are gone or deprioritised — cues react to the most recent speech

---

### Test 3 — End & save

Single-tap to end the meeting.

**Pass criteria:**
- Display shows `Summarizing & saving…`
- Summary screen shows both topics (contract renewal + GDPR)
- `Saved to Salesforce ✓` appears at the bottom

Verify in Salesforce:
```bash
cd salesforce && sf data query --target-org evenTest \
  --query "SELECT Name, Summary__c, Action_Items__c, Meeting_Date__c \
           FROM Meeting_Note__c ORDER BY CreatedDate DESC LIMIT 1"
```

---

## Proxy tests

```bash
cd proxy && node --test
# 65 tests, 0 failures
```

---

## Deploying to Heroku

The proxy is already deployed at `https://sf-evenhub-proxy-4f011c764460.herokuapp.com`.

To push a new version:
```bash
cd proxy
heroku git:remote -a sf-evenhub-proxy
git push heroku HEAD:main
```

To deploy the app pointing at Heroku (no `.env.local` needed — it's the default):
```bash
cd app
npm run build
evenhub pack app.json dist
```

Then re-generate the QR pointing to the packed `.ehpk` hosted on any static server or via Heroku.
