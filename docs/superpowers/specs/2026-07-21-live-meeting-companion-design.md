# Design: Live Meeting Companion

Date: 2026-07-21
Status: Approved

## Goal

Extend the EvenRealities × Salesforce integration with the live-meeting loop:
from an account's detail view, a salesperson starts a meeting, sees rolling
AI **cues** on the glasses while talking, has the conversation transcribed
continuously, then ends the meeting to have an LLM **summary + action items +
next steps** written to a new `Meeting_Note__c` in Salesforce (linked to the
Account and, when available, the `Meeting_Prep__c`).

## Constraints

- Display: single monochrome text container, 576×288, ~proportional font,
  updated in place (~every 20s during a meeting).
- Audio: the G2 mic streams PCM16 (16kHz mono) frames via
  `event.audioEvent.audioPcm` while `bridge.audioControl(true, Glasses)` is on.
  The proxy already transcribes PCM via `transcribePcm` (OpenAI Whisper).
- Proxy: Node ≥20, ESM, Express, `jsforce`; reuse existing helpers
  (`transcribePcm`, `openaiChat`, `createRecord`/`getWriteConnection`, `runQuery`).
  No new npm deps for tests (`node:test`).
- Never dead-end: cues fall back to the prep talking points, and the summary
  falls back to a deterministic template, when OpenAI is unavailable.
- Gestures available: single-tap, double-tap, scroll (up/down). No long-press.

## User flow

1. Account detail view → **double-tap** → start meeting for this account.
2. App calls `POST /meeting/start { accountId, prepId? }`, receives `sessionId`
   and initial cues (from the prep talking points), enters `meeting` view, and
   turns the mic on (mic stays on for the whole meeting).
3. Every ~20s the app snapshots and clears the accumulated PCM, sends it to
   `POST /meeting/:id/chunk { audioBase64 }`, and receives the new transcript
   delta + refreshed cues, which replace the on-screen cues.
4. **Single-tap** → end & save: the app flushes any remaining audio, calls
   `POST /meeting/:id/end`, which composes the summary and writes
   `Meeting_Note__c`; the app shows a summary/confirmation screen.
   **Double-tap** during a meeting → discard (end session, no Salesforce write).
5. Summary screen → single-tap → back to accounts.

## Meeting-mode screen (mockup)

```
● REC 02:14   NovaMind AI

Live cues
 • Ask status of the API latency case
 • Confirm the Phase 2 budget owner
 • Cite Phase 1 success metrics

"...the timeline for the expansion is our
 main concern right now..."

Tap: end & save   x2: discard
```

## Gesture map (additions)

- `detail` view: single-tap = back (unchanged); **double-tap = start meeting**
  for the current account (replaces the redundant voice-search in this view).
- `meeting` view: single-tap = end & save; double-tap = discard; scroll =
  scroll transcript tail.
- `meetingSummary` view: single-tap = back to accounts.

## Architecture

### Proxy (new modules, dependency-injected, TDD)

- `lib/meeting/session.js` — `createMeetingStore()` returning an in-memory
  `Map`-backed store: `start({accountId, prepId, cues})` → `{ id }`;
  `get(id)`; `appendTranscript(id, text)`; `setCues(id, cues)`; `end(id)`.
  Session shape: `{ id, accountId, prepId, transcript, cues, startedAt, status }`.
- `lib/meeting/cues.js`:
  - `buildCuesPrompt({ prepPoints, transcript })` → `{ system, user }`.
  - `fallbackCues({ prepPoints })` → `string[]` (the prep talking points, ≤3).
  - `composeCues({ prepPoints, transcript, openaiChat })` →
    `{ cues: string[] (≤3), source: 'openai' | 'prep' }`. On error/empty, returns
    `fallbackCues`.
- `lib/meeting/summary.js`:
  - `buildSummaryPrompt({ accountName, transcript })` → `{ system, user }`.
  - `fallbackSummary({ transcript })` → `{ summary, actionItems, nextSteps }`
    (deterministic: truncated transcript as summary, empty action/next lists
    rendered as a short note).
  - `composeMeetingSummary({ accountName, transcript, openaiChat })` →
    `{ summary: string, actionItems: string[], nextSteps: string[], source }`.
    Parses a JSON object from the LLM; falls back on error/invalid.
- `lib/meeting/record.js`:
  - `buildMeetingNoteRecord({ accountId, prepId, transcript, summary,
    actionItems, nextSteps, startedAt })` → the `Meeting_Note__c` field object
    (arrays joined into bulleted long-text).
  - `writeMeetingNote({ createRecord, record })` → `{ id }`.
- `routes/meeting.js` — `makeMeetingRouter({ transcribePcm, openaiChat,
  createRecord, store, loadPrepContext })`:
  - `POST /meeting/start { accountId }` → `loadPrepContext(accountId)` →
    create session (seeded with `prepId` + seed cues), return
    `{ sessionId, cues }`.
  - `POST /meeting/:id/chunk { audioBase64 }` → `transcribePcm` → append →
    `composeCues` → return `{ transcript: <delta>, cues }`.
  - `POST /meeting/:id/end` → `composeMeetingSummary` → `writeMeetingNote` →
    return `{ summary, actionItems, nextSteps, recordId, saved }`.
- `server.js` — construct one shared `store`, define
  `loadPrepContext(accountId)` → `{ prepId, prepPoints }`, where `prepId` is the
  most recent `Meeting_Prep__c` for the account (SOQL, or `null`) and
  `prepPoints` are seeded by reusing `gatherAccountData` + `composeTalkingPoints`
  (the same CRM-derived talking points the detail view shows); returns
  `{ prepId: null, prepPoints: [] }` on error. Mount the router.

Design note: initial cues are seeded from `composeTalkingPoints` (CRM-derived)
rather than parsing the narrative `Brief__c`, because the prep record stores a
free-text brief, not a discrete points list. The `Meeting_Prep__c` lookup is
still populated when a prep record exists.

### Salesforce (SFDX metadata)

New `Meeting_Note__c` object with fields:
- `Account__c` — Lookup(Account), required.
- `Meeting_Prep__c` — Lookup(Meeting_Prep__c), optional.
- `Meeting_Date__c` — DateTime.
- `Transcript__c` — Long Text Area.
- `Summary__c` — Long Text Area.
- `Action_Items__c` — Long Text Area.
- `Next_Steps__c` — Long Text Area.

Add object CRUD + field R/W to the existing `Meeting_Prep_Access` permission set
so the proxy's integration user can write it.

### App (`app/src/main.ts`)

- New views `meeting` and `meetingSummary`; new state:
  `meetingSessionId`, `meetingCues`, `meetingTranscriptTail`, `meetingStartMs`,
  and a `flushTimer` handle.
- `startMeeting(account)` — `POST /meeting/start`, enter `meeting` view, turn mic
  on, start the ~20s flush timer, render the meeting screen.
- `flushMeetingChunk()` — snapshot+clear `pcmChunks`, base64, `POST
  /meeting/:id/chunk`, update cues + transcript tail, re-render (guarded to the
  active session/view).
- `endMeeting(save)` — stop timer, mic off, flush remainder; if `save`, `POST
  /meeting/:id/end` and show the summary screen; else discard and return to
  accounts.
- Pure render helpers `renderMeeting({ cues, elapsedMs, accountName,
  transcriptTail })` and `renderMeetingSummary(result)`.
- Wire the gestures per the gesture map.

## Error handling

- `/chunk` transcription error → return the existing cues unchanged and an empty
  delta; the meeting continues (a dropped chunk must not end the meeting).
- OpenAI unavailable → cues fall back to prep points; summary falls back to the
  deterministic template. The `Meeting_Note__c` is still written.
- `/end` Salesforce write failure → return the composed summary with a
  `saved:false` flag and an error message; the app shows the summary and notes
  it wasn't saved (never lose the content).
- Unknown/expired `sessionId` → 404 `{ error: 'unknown_session' }`; the app
  returns to accounts with a short message.
- App: if the mic fails to start, show an error and stay on the detail view.

## Testing

- Proxy (TDD, `node:test` + dependency injection):
  - `session.test.js`: lifecycle (start/get/append/setCues/end), unknown id.
  - `cues.test.js`: prompt build, `composeCues` OpenAI success (≤3), fallback to
    prep points on throw/empty.
  - `summary.test.js`: prompt build, JSON parse success, fallback on
    invalid/throw; arrays normalized.
  - `record.test.js`: field mapping (arrays → bulleted long text, optional
    `Meeting_Prep__c` omitted when absent), `writeMeetingNote` calls
    `createRecord` with `Meeting_Note__c`.
  - `routes-meeting.test.js`: start → chunk → end happy path with stubbed
    `transcribePcm`/`openaiChat`/`createRecord`/`loadPrepPoints`; unknown session
    404; end-with-write-failure returns `saved:false`.
- App: pure render helpers kept side-effect free; verified by a clean
  `tsc && vite build`.
- Live: after deploy, exercise start/chunk/end against the org + OpenAI and
  confirm a `Meeting_Note__c` row is created (controller-run, as with prep).

## Out of scope

- Speaker diarization / attributing lines to salesperson vs customer.
- Sentiment/risk scoring and objection detection (deferred).
- Persisting audio; only the transcript + derived fields are stored.
- Editing the note from the glasses after it's written.
