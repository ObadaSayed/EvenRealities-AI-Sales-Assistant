# Subsystem A — Voice-Triggered Meeting Prep (Design)

Date: 2026-07-19
Status: Approved for planning
Owner: EvenRealities × Salesforce integration

## Context

This is the first buildable subsystem of a larger EvenRealities G2 ↔ Salesforce
integration. The full vision (tracked separately) decomposes into:

- **A. Meeting-prep generation** — *this spec*
- B. Live meeting assist (real-time cues on the glasses)
- C. Post-meeting capture (glasses conversation summary → CRM)
- D. Scheduled follow-up automation
- E. Real-time ad-hoc query with a chart on the glasses

Each subsystem gets its own spec → plan → implementation cycle. Only **A** is in
scope here.

### Existing foundation (reused, not rebuilt)

- `proxy/server.js` — Express + jsforce on Heroku. Already has: Salesforce auth
  (`sf` CLI session locally, `SFDX_AUTH_URL` on Heroku), SOQL helpers
  (`runQuery`, `findAccount`, `extractAccountName`, `soqlEscape`, `assertValidId`),
  Whisper STT (`transcribePcm`), Agentforce client, and Slack DM integration.
- `app/` — Even Hub SDK app (Vite + TS). Already captures glasses mic PCM and
  renders text containers; has a working tap/swipe/voice interaction model.
- Glasses display reality: monochrome ~576×288, text containers (max 8) and
  image containers (max 4, ≤288×144, grayscale). Input: taps/swipes + mic PCM.
- Hosting: Heroku (existing dyno). Salesforce org is already authenticated.

## Goal

A salesperson wearing the G2 glasses speaks a prep request
("prep me for the Omega meeting"). The proxy gathers real CRM data plus mocked
external context, composes a briefing with an LLM, and writes it to a new
Salesforce custom object linked to the Account. The glasses show a short
confirmation.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Trigger surface | **Glasses voice only** (Slack not involved in A) |
| Orchestrator | **Node proxy** (extend existing `server.js`) |
| Real data sources | **Salesforce CRM core only**: Account, Opportunity, Case, Contact |
| Mocked sources | RFPs/documents, attendee web research, calendar (clearly illustrative) |
| Output | Rich text on a **new Salesforce custom object** linked to Account (no Slack Canvas) |
| Attendees | **Real Salesforce Contacts** on the Account; research narrative mocked |
| Composition | **OpenAI** (already used for Whisper), deterministic-template fallback |
| Execution model | **Async job** with immediate ack + glasses poll |
| Target | Even Hub **simulator** (consistent with the rest of the repo) |

## Architecture & Data Flow

```
G2 glasses (voice)                 Node proxy (Heroku)                    Salesforce
──────────────────                 ────────────────────                   ──────────
1. Tap "Prep meeting",   ──PCM──>  POST /prep
   speak "prep me for                • Whisper STT → transcript
   the Omega meeting"                • parse intent + account name
                         <─jobId──   • create job {id, status:running}
2. Show "Preparing                   • return immediately (async ack)
   brief for Omega…"
                                     ── background worker ──
                                       a. resolve Account            ──SOQL──> Account
                                       b. gather (parallel):
                                          Opportunities (revenue)    ──SOQL──> Opportunity
                                          Cases (complaints)         ──SOQL──> Case
                                          Contacts (attendees)       ──SOQL──> Contact
                                       c. build MOCK sections:
                                          RFPs/docs, attendee
                                          web-research, calendar
                                       d. compose brief (OpenAI)
                                       e. create record              ──REST──> Meeting_Prep__c
                                       f. job.status = done
3. Poll GET /prep/:id     ─────>     returns {status, recordId, summary}
   every ~2s
4. Show "Prep ready for
   Omega — saved to SF"
```

## Components

Each unit has one purpose, a well-defined interface, and is independently
testable (Salesforce and OpenAI are stubbed in tests).

### Proxy

- `POST /prep` — accepts `{ audioBase64 }` (voice) or `{ text }` (testing).
  Runs STT (when audio), parses intent, creates a job, returns
  `{ jobId, account, status: "started" }` immediately.
- `GET /prep/:jobId` — returns
  `{ status: "running"|"done"|"failed", recordId?, summary?, error? }`.
- `parsePrepIntent(text)` — detects prep intent + extracts account name
  (reuses `extractAccountName`). Returns `{ isPrep, accountName }`.
- `gatherAccountData(accountId)` — parallel SOQL for Account, Opportunities,
  Cases, Contacts. Returns a normalized object.
- `mockProviders`:
  - `mockRfps(account)` — recent RFP/document list.
  - `mockAttendeeResearch(contacts)` — per-contact illustrative career/education
    narrative (labelled illustrative).
  - `mockCalendar(account)` — upcoming meeting date/time.
- `composeBrief(data)` — OpenAI call, structured prompt → sectioned brief text.
  Deterministic-template fallback on any OpenAI error.
- `writeMeetingPrep(record)` — `conn.sobject('Meeting_Prep__c').create(...)`.
- `jobs` — in-memory `Map` keyed by jobId (acceptable for demo; per-dyno).

### Salesforce metadata (deployable via `sf project deploy`)

New custom object `Meeting_Prep__c`:

| Field | Type | Purpose |
|---|---|---|
| `Account__c` | Lookup(Account) | Links prep to the account |
| `Brief__c` | Long Text Area (rich) | Composed brief |
| `Meeting_Date__c` | Date | Mocked meeting time |
| `Attendees__c` | Long Text Area | Names + titles |
| `Status__c` | Picklist (Ready / Failed / Draft) | Job outcome |
| `Source__c` | Text(50) | e.g. `glasses-voice` |
| `Transcript__c` | Text(255) | Original spoken request |
| `Name` | Auto Number (`Prep-{0000}`) | Record name |

### Glasses app

One new "Prep meeting" view:
- Reuses existing mic capture (PCM chunks).
- POSTs PCM to `/prep`, shows "Preparing brief for {Account}…".
- Polls `/prep/:jobId` (~2s interval, ~30s cap).
- On `done`: shows "Prep ready for {Account} — saved to Salesforce" plus a
  condensed summary (e.g. counts of opps / open cases). On `failed`: short error.

## Error Handling

Follows the existing "never dead-end the demo" pattern:

- STT failure → job `failed`; glasses: "Didn't catch that — tap to retry."
- No account match → glasses: "No account found matching '{name}'."
- OpenAI failure → fall back to deterministic-template brief; still write the
  record (mirrors the existing SOQL-fallback behavior).
- Salesforce write failure → job `failed` with detail; glasses show a short error.
- Poll timeout (~30s) → glasses: "Still working — check Salesforce."

## Testing

Repo currently has no tests. Add a light harness using Node's built-in
`node:test` (no new dependencies).

- **Unit**
  - `parsePrepIntent` — prep detection + account extraction across phrasings.
  - `mockProviders` — deterministic output shape.
  - `composeBrief` prompt-builder — correct sections from input; template
    fallback path.
  - `writeMeetingPrep` — maps to the correct `Meeting_Prep__c` fields.
- **Integration** (Salesforce + OpenAI stubbed)
  - `POST /prep` returns a jobId and `started`.
  - Background job transitions `running` → `done`.
  - `GET /prep/:jobId` returns the documented shape.
  - `writeMeetingPrep` invoked with expected field values.
- **Manual**
  - Even Hub simulator voice flow end-to-end against the authenticated org,
    using the simulator `--automation-port` for a scripted click/voice run.

## Out of Scope (explicitly)

- Slack (Canvas or bot) — not part of A.
- Real web search, real calendar, real document/RFP retrieval — mocked here.
- Live in-meeting cues, post-meeting capture, follow-up automation, charts —
  subsystems B–E.
- Durable job storage (in-memory Map is sufficient for the demo).

## Execution Plan (Superpowers pipeline)

1. **writing-plans** — phased, checkpointed implementation plan.
2. **using-git-worktrees** — isolated worktree/branch for the prototype.
3. **test-driven-development** — failing tests first per unit, then implement
   with Salesforce/OpenAI stubs.
4. **subagent-driven-development / dispatching-parallel-agents** — build
   independent units (mock-providers, SF metadata, glasses view) in parallel.
5. **verification-before-completion** — full test run + scripted simulator run.
6. **requesting-code-review** — review the diff.
7. **finishing-a-development-branch** — merge / PR / cleanup.
