# Live Meeting Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live-meeting loop: start a meeting from an account, show rolling AI cues on the glasses, transcribe the conversation continuously, then on end write an LLM summary + action items + next steps to a new `Meeting_Note__c` in Salesforce.

**Architecture:** New proxy modules under `lib/meeting/` (session store, cues, summary, record) exposed via `routes/meeting.js` (`/meeting/start`, `/meeting/:id/chunk`, `/meeting/:id/end`), reusing existing `transcribePcm`, `openaiChat`, `createRecord`, `gatherAccountData`, and `composeTalkingPoints`. A new `Meeting_Note__c` SFDX object. The app gains `meeting`/`meetingSummary` views with a ~20s PCM flush loop.

**Tech Stack:** Node ≥20 ESM, Express, jsforce, OpenAI (Whisper + chat), `node:test`; app is TypeScript + Vite; Salesforce via SFDX + `sf` CLI.

## Global Constraints

- Node ≥20, ESM only. No new npm dependencies (tests use `node:test` + `node:assert`).
- Proxy code lives in the nested `proxy/` git repo; `app/`, `salesforce/`, and `docs/` live in the root repo. Commit with inline identity: `git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "..."`. Stage only each task's files (never `git add -A`).
- Never dead-end: cues fall back to seed/prep points; summary falls back to a deterministic template; a Salesforce write failure still returns the composed summary with `saved:false`.
- A proxy dev server may be running on port 3000 — do not kill it; tests run offline.
- Reuse existing helpers; do not duplicate `transcribePcm`/`openaiChat`/`createRecord`/`gatherAccountData`/`composeTalkingPoints`.

---

### Task 1: Meeting session store

**Files:**
- Create: `proxy/lib/meeting/session.js`
- Test: `proxy/test/meeting-session.test.js`

**Interfaces:**
- Produces: `createMeetingStore()` → `{ start, get, appendTranscript, setCues, end }`.
  - `start({ accountId, prepId = null, cues = [], prepPoints = [] })` → `{ id }` (unique string id).
  - `get(id)` → session `{ id, accountId, prepId, prepPoints, transcript, cues, startedAt, status }` or `undefined`.
  - `appendTranscript(id, text)` → updated session (space-joined, trimmed); throws `Error('unknown_session')` if missing.
  - `setCues(id, cues)` → updated session; throws `Error('unknown_session')` if missing.
  - `end(id)` → session with `status:'ended'`; throws `Error('unknown_session')` if missing.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/meeting-session.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMeetingStore } from '../lib/meeting/session.js'

test('start creates a retrievable session with defaults', () => {
  const store = createMeetingStore()
  const { id } = store.start({ accountId: '001', prepId: 'a01', cues: ['x'], prepPoints: ['p1', 'p2'] })
  const s = store.get(id)
  assert.equal(s.accountId, '001')
  assert.equal(s.prepId, 'a01')
  assert.deepEqual(s.cues, ['x'])
  assert.deepEqual(s.prepPoints, ['p1', 'p2'])
  assert.equal(s.transcript, '')
  assert.equal(s.status, 'active')
  assert.ok(typeof s.startedAt === 'number')
})

test('appendTranscript accumulates with single spaces', () => {
  const store = createMeetingStore()
  const { id } = store.start({ accountId: '001' })
  store.appendTranscript(id, 'hello')
  const s = store.appendTranscript(id, 'world')
  assert.equal(s.transcript, 'hello world')
})

test('setCues replaces cues', () => {
  const store = createMeetingStore()
  const { id } = store.start({ accountId: '001' })
  store.setCues(id, ['a', 'b'])
  assert.deepEqual(store.get(id).cues, ['a', 'b'])
})

test('end marks status ended', () => {
  const store = createMeetingStore()
  const { id } = store.start({ accountId: '001' })
  assert.equal(store.end(id).status, 'ended')
})

test('operations on unknown id throw unknown_session', () => {
  const store = createMeetingStore()
  assert.throws(() => store.appendTranscript('nope', 'x'), /unknown_session/)
  assert.throws(() => store.setCues('nope', []), /unknown_session/)
  assert.throws(() => store.end('nope'), /unknown_session/)
  assert.equal(store.get('nope'), undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/meeting-session.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `proxy/lib/meeting/session.js`:
```js
import { randomUUID } from 'node:crypto'

export function createMeetingStore() {
  const sessions = new Map()

  function require(id) {
    const s = sessions.get(id)
    if (!s) throw new Error('unknown_session')
    return s
  }

  return {
    start({ accountId, prepId = null, cues = [], prepPoints = [] }) {
      const id = randomUUID()
      sessions.set(id, {
        id,
        accountId,
        prepId,
        prepPoints,
        transcript: '',
        cues,
        startedAt: Date.now(),
        status: 'active',
      })
      return { id }
    },
    get(id) {
      return sessions.get(id)
    },
    appendTranscript(id, text) {
      const s = require(id)
      const add = String(text || '').trim()
      s.transcript = s.transcript ? (add ? `${s.transcript} ${add}` : s.transcript) : add
      return s
    },
    setCues(id, cues) {
      const s = require(id)
      s.cues = cues
      return s
    },
    end(id) {
      const s = require(id)
      s.status = 'ended'
      return s
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/meeting-session.test.js` → PASS. Then `cd proxy && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/meeting/session.js test/meeting-session.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add in-memory meeting session store"
```

---

### Task 2: Live cues module

**Files:**
- Create: `proxy/lib/meeting/cues.js`
- Test: `proxy/test/meeting-cues.test.js`

**Interfaces:**
- Consumes: injected `openaiChat({ system, user }) -> Promise<string>`.
- Produces:
  - `fallbackCues({ prepPoints }) -> string[]` (first ≤3 of `prepPoints`).
  - `buildCuesPrompt({ prepPoints, transcript }) -> { system, user }`.
  - `composeCues({ prepPoints, transcript, openaiChat }) -> Promise<{ cues: string[] (≤3), source: 'openai' | 'prep' }>`.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/meeting-cues.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackCues, buildCuesPrompt, composeCues } from '../lib/meeting/cues.js'

const prepPoints = ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win', 'Extra point']

test('fallbackCues returns up to 3 prep points', () => {
  assert.deepEqual(fallbackCues({ prepPoints }), ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win'])
})

test('buildCuesPrompt includes transcript and prep points', () => {
  const { system, user } = buildCuesPrompt({ prepPoints, transcript: 'customer mentioned budget' })
  assert.match(system, /cue/i)
  assert.match(user, /budget/)
  assert.match(user, /Phase 2/)
})

test('composeCues parses up to 3 bullets from OpenAI', async () => {
  const openaiChat = async () => '- Ask about budget owner\n- Address latency\n- Offer pilot\n- Too many'
  const r = await composeCues({ prepPoints, transcript: 't', openaiChat })
  assert.equal(r.source, 'openai')
  assert.deepEqual(r.cues, ['Ask about budget owner', 'Address latency', 'Offer pilot'])
})

test('composeCues falls back to prep points on throw', async () => {
  const openaiChat = async () => { throw new Error('no key') }
  const r = await composeCues({ prepPoints, transcript: 't', openaiChat })
  assert.equal(r.source, 'prep')
  assert.deepEqual(r.cues, ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win'])
})

test('composeCues falls back on empty completion', async () => {
  const openaiChat = async () => '   '
  const r = await composeCues({ prepPoints, transcript: 't', openaiChat })
  assert.equal(r.source, 'prep')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/meeting-cues.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `proxy/lib/meeting/cues.js`:
```js
export function fallbackCues({ prepPoints }) {
  return (prepPoints || []).slice(0, 3)
}

export function buildCuesPrompt({ prepPoints, transcript }) {
  const system =
    'You are a real-time sales meeting assistant. Given the pre-meeting talking ' +
    'points and the recent conversation transcript, output up to 3 very short cue ' +
    'lines (max ~60 chars each) the salesperson should say or ask NEXT. Imperative, ' +
    'specific to what was just said. Return only the cues, one per line, no numbering.'
  const points = (prepPoints || []).map((p) => `- ${p}`).join('\n') || '(none)'
  const user =
    `Pre-meeting talking points:\n${points}\n\n` +
    `Recent conversation:\n${String(transcript || '').slice(-1500) || '(nothing yet)'}`
  return { system, user }
}

function parseCues(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
}

export async function composeCues({ prepPoints, transcript, openaiChat }) {
  try {
    const { system, user } = buildCuesPrompt({ prepPoints, transcript })
    const reply = await openaiChat({ system, user })
    const cues = parseCues(reply)
    if (cues.length === 0) throw new Error('empty completion')
    return { cues, source: 'openai' }
  } catch {
    return { cues: fallbackCues({ prepPoints }), source: 'prep' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/meeting-cues.test.js` → PASS. Then `cd proxy && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/meeting/cues.js test/meeting-cues.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add live meeting cues (LLM + prep fallback)"
```

---

### Task 3: Meeting summary module

**Files:**
- Create: `proxy/lib/meeting/summary.js`
- Test: `proxy/test/meeting-summary.test.js`

**Interfaces:**
- Consumes: injected `openaiChat`.
- Produces:
  - `fallbackSummary({ transcript }) -> { summary, actionItems: [], nextSteps: [] }`.
  - `buildSummaryPrompt({ accountName, transcript }) -> { system, user }`.
  - `composeMeetingSummary({ accountName, transcript, openaiChat }) -> Promise<{ summary: string, actionItems: string[], nextSteps: string[], source: 'openai' | 'template' }>`. Parses a JSON object `{summary, actionItems, nextSteps}` from the reply (tolerating code fences); falls back on throw/invalid/empty.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/meeting-summary.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackSummary, buildSummaryPrompt, composeMeetingSummary } from '../lib/meeting/summary.js'

test('fallbackSummary uses transcript text and empty lists', () => {
  const r = fallbackSummary({ transcript: 'We discussed the Phase 2 timeline.' })
  assert.match(r.summary, /Phase 2/)
  assert.deepEqual(r.actionItems, [])
  assert.deepEqual(r.nextSteps, [])
})

test('buildSummaryPrompt requests JSON and includes account + transcript', () => {
  const { system, user } = buildSummaryPrompt({ accountName: 'Acme', transcript: 'talked budget' })
  assert.match(system, /json/i)
  assert.match(user, /Acme/)
  assert.match(user, /budget/)
})

test('composeMeetingSummary parses JSON (with code fence)', async () => {
  const openaiChat = async () =>
    '```json\n{"summary":"Discussed Phase 2.","actionItems":["Send SOW"],"nextSteps":["Review next week"]}\n```'
  const r = await composeMeetingSummary({ accountName: 'Acme', transcript: 't', openaiChat })
  assert.equal(r.source, 'openai')
  assert.equal(r.summary, 'Discussed Phase 2.')
  assert.deepEqual(r.actionItems, ['Send SOW'])
  assert.deepEqual(r.nextSteps, ['Review next week'])
})

test('composeMeetingSummary falls back on invalid JSON', async () => {
  const openaiChat = async () => 'not json at all'
  const r = await composeMeetingSummary({ accountName: 'Acme', transcript: 'discussed budget', openaiChat })
  assert.equal(r.source, 'template')
  assert.match(r.summary, /budget/)
})

test('composeMeetingSummary falls back on throw', async () => {
  const openaiChat = async () => { throw new Error('no key') }
  const r = await composeMeetingSummary({ accountName: 'Acme', transcript: 'x', openaiChat })
  assert.equal(r.source, 'template')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/meeting-summary.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `proxy/lib/meeting/summary.js`:
```js
export function fallbackSummary({ transcript }) {
  const text = String(transcript || '').trim()
  const summary = text ? text.slice(0, 1000) : 'No conversation was captured.'
  return { summary, actionItems: [], nextSteps: [] }
}

export function buildSummaryPrompt({ accountName, transcript }) {
  const system =
    'You are a sales meeting scribe. Summarize the meeting transcript for the CRM. ' +
    'Respond with ONLY a JSON object of the form ' +
    '{"summary": string, "actionItems": string[], "nextSteps": string[]}. ' +
    'Keep the summary under 200 words; each list item one short line. No prose outside the JSON.'
  const user =
    `Account: ${accountName}\n\nTranscript:\n${String(transcript || '').slice(0, 12000) || '(empty)'}`
  return { system, user }
}

function toStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return []
}

export async function composeMeetingSummary({ accountName, transcript, openaiChat }) {
  try {
    const { system, user } = buildSummaryPrompt({ accountName, transcript })
    const reply = await openaiChat({ system, user })
    const raw = String(reply || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(raw)
    const summary = String(parsed.summary || '').trim()
    if (!summary) throw new Error('empty summary')
    return {
      summary,
      actionItems: toStringArray(parsed.actionItems),
      nextSteps: toStringArray(parsed.nextSteps),
      source: 'openai',
    }
  } catch {
    return { ...fallbackSummary({ transcript }), source: 'template' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/meeting-summary.test.js` → PASS. Then `cd proxy && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/meeting/summary.js test/meeting-summary.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add meeting summary compose (JSON LLM + template fallback)"
```

---

### Task 4: Meeting note record builder

**Files:**
- Create: `proxy/lib/meeting/record.js`
- Test: `proxy/test/meeting-record.test.js`

**Interfaces:**
- Consumes: injected `createRecord(sobject, fields) -> Promise<{ id }>` (existing server helper).
- Produces:
  - `buildMeetingNoteRecord({ accountId, prepId, transcript, summary, actionItems, nextSteps, startedAt }) -> object` with `Meeting_Note__c` fields. `Meeting_Prep__c` key present only when `prepId` truthy. Arrays joined into `"- a\n- b"` long text. `Meeting_Date__c` = ISO string from `startedAt`. `Transcript__c`/`Summary__c` present.
  - `writeMeetingNote({ createRecord, record }) -> Promise<{ id }>`; throws if no id.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/meeting-record.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMeetingNoteRecord, writeMeetingNote } from '../lib/meeting/record.js'

test('buildMeetingNoteRecord maps fields and joins arrays', () => {
  const rec = buildMeetingNoteRecord({
    accountId: '001',
    prepId: 'a01',
    transcript: 'full transcript',
    summary: 'Discussed Phase 2.',
    actionItems: ['Send SOW', 'Call Khalid'],
    nextSteps: ['Review next week'],
    startedAt: 1700000000000,
  })
  assert.equal(rec.Account__c, '001')
  assert.equal(rec.Meeting_Prep__c, 'a01')
  assert.equal(rec.Summary__c, 'Discussed Phase 2.')
  assert.equal(rec.Transcript__c, 'full transcript')
  assert.equal(rec.Action_Items__c, '- Send SOW\n- Call Khalid')
  assert.equal(rec.Next_Steps__c, '- Review next week')
  assert.equal(rec.Meeting_Date__c, new Date(1700000000000).toISOString())
})

test('buildMeetingNoteRecord omits Meeting_Prep__c when prepId absent', () => {
  const rec = buildMeetingNoteRecord({ accountId: '001', prepId: null, transcript: '', summary: 's', actionItems: [], nextSteps: [], startedAt: 1 })
  assert.equal('Meeting_Prep__c' in rec, false)
  assert.equal(rec.Action_Items__c, '')
})

test('writeMeetingNote calls createRecord and returns id', async () => {
  let called
  const createRecord = async (sobject, fields) => { called = { sobject, fields }; return { id: '0Nx1' } }
  const out = await writeMeetingNote({ createRecord, record: { Account__c: '001' } })
  assert.equal(out.id, '0Nx1')
  assert.equal(called.sobject, 'Meeting_Note__c')
})

test('writeMeetingNote throws when no id returned', async () => {
  const createRecord = async () => ({})
  await assert.rejects(writeMeetingNote({ createRecord, record: {} }), /no id/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/meeting-record.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `proxy/lib/meeting/record.js`:
```js
function bulletJoin(items) {
  return (items || []).map((i) => `- ${i}`).join('\n')
}

export function buildMeetingNoteRecord({
  accountId,
  prepId,
  transcript,
  summary,
  actionItems,
  nextSteps,
  startedAt,
}) {
  const record = {
    Account__c: accountId ?? null,
    Meeting_Date__c: new Date(startedAt || Date.now()).toISOString(),
    Transcript__c: String(transcript ?? ''),
    Summary__c: String(summary ?? ''),
    Action_Items__c: bulletJoin(actionItems),
    Next_Steps__c: bulletJoin(nextSteps),
  }
  if (prepId) record.Meeting_Prep__c = prepId
  return record
}

export async function writeMeetingNote({ createRecord, record }) {
  const res = await createRecord('Meeting_Note__c', record)
  const id = res?.id || res?.Id
  if (!id) throw new Error('create returned no id')
  return { id }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/meeting-record.test.js` → PASS. Then `cd proxy && npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/meeting/record.js test/meeting-record.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add Meeting_Note__c record builder + writer"
```

---

### Task 5: Meeting routes + server wiring

**Files:**
- Create: `proxy/routes/meeting.js`
- Create: `proxy/test/routes-meeting.test.js`
- Modify: `proxy/server.js` (import, `loadPrepContext`, shared store, mount)

**Interfaces:**
- Consumes: `createMeetingStore` (session.js), `composeCues` (cues.js), `composeMeetingSummary` (summary.js), `buildMeetingNoteRecord`/`writeMeetingNote` (record.js); injected deps `{ transcribePcm, openaiChat, createRecord, store, loadPrepContext }`.
  - `transcribePcm(base64) -> Promise<string>` (existing).
  - `loadPrepContext(accountId) -> Promise<{ prepId: string|null, prepPoints: string[] }>`.
- Produces: `makeMeetingRouter(deps)` mounting:
  - `POST /meeting/start { accountId }` → `{ sessionId, cues }`.
  - `POST /meeting/:id/chunk { audioBase64 }` → `{ transcript, cues }` (transcript = this chunk's delta).
  - `POST /meeting/:id/end` → `{ summary, actionItems, nextSteps, recordId, saved }`.
  - Unknown session → 404 `{ error: 'unknown_session' }`.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/routes-meeting.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createMeetingStore } from '../lib/meeting/session.js'
import { makeMeetingRouter } from '../routes/meeting.js'

function start(deps) {
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use(makeMeetingRouter(deps))
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

function baseDeps(overrides = {}) {
  return {
    store: createMeetingStore(),
    transcribePcm: async () => 'customer said budget is approved',
    openaiChat: async () => '- Confirm budget owner\n- Propose pilot',
    createRecord: async () => ({ id: '0Nx1' }),
    loadPrepContext: async () => ({ prepId: 'a01', prepPoints: ['Push Phase 2', 'Cite Phase 1'] }),
    ...overrides,
  }
}

test('start -> chunk -> end happy path', async () => {
  const { server, port } = await start(baseDeps())
  const s = await (await fetch(`http://localhost:${port}/meeting/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: '001' }),
  })).json()
  assert.ok(s.sessionId)
  assert.deepEqual(s.cues, ['Push Phase 2', 'Cite Phase 1'])

  const c = await (await fetch(`http://localhost:${port}/meeting/${s.sessionId}/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: 'AAAA' }),
  })).json()
  assert.match(c.transcript, /budget/)
  assert.deepEqual(c.cues, ['Confirm budget owner', 'Propose pilot'])

  const e = await (await fetch(`http://localhost:${port}/meeting/${s.sessionId}/end`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json()
  server.close()
  assert.equal(e.saved, true)
  assert.equal(e.recordId, '0Nx1')
  assert.ok(typeof e.summary === 'string')
})

test('unknown session returns 404', async () => {
  const { server, port } = await start(baseDeps())
  const res = await fetch(`http://localhost:${port}/meeting/nope/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64: 'AAAA' }),
  })
  server.close()
  assert.equal(res.status, 404)
})

test('end returns saved:false when write fails', async () => {
  const deps = baseDeps({ createRecord: async () => { throw new Error('FLS denied') } })
  const { server, port } = await start(deps)
  const s = await (await fetch(`http://localhost:${port}/meeting/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: '001' }),
  })).json()
  const e = await (await fetch(`http://localhost:${port}/meeting/${s.sessionId}/end`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json()
  server.close()
  assert.equal(e.saved, false)
  assert.ok(typeof e.summary === 'string')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/routes-meeting.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement the router**

Create `proxy/routes/meeting.js`:
```js
import express from 'express'
import { composeCues } from '../lib/meeting/cues.js'
import { composeMeetingSummary } from '../lib/meeting/summary.js'
import { buildMeetingNoteRecord, writeMeetingNote } from '../lib/meeting/record.js'

export function makeMeetingRouter(deps) {
  const { transcribePcm, openaiChat, createRecord, store, loadPrepContext } = deps
  const router = express.Router()

  router.post('/meeting/start', async (req, res) => {
    try {
      const accountId = req.body?.accountId
      if (!accountId) return res.status(400).json({ error: 'missing_account' })
      const { prepId, prepPoints } = await loadPrepContext(accountId)
      const { id } = store.start({
        accountId,
        prepId,
        prepPoints: prepPoints || [],
        cues: (prepPoints || []).slice(0, 3),
      })
      res.json({ sessionId: id, cues: store.get(id).cues })
    } catch (err) {
      res.status(502).json({ error: err.message || 'start_failed' })
    }
  })

  router.post('/meeting/:id/chunk', async (req, res) => {
    const id = req.params.id
    if (!store.get(id)) return res.status(404).json({ error: 'unknown_session' })
    try {
      let delta = ''
      try {
        delta = await transcribePcm(req.body?.audioBase64)
      } catch (err) {
        // A dropped chunk must not end the meeting: keep existing cues.
        return res.json({ transcript: '', cues: store.get(id).cues })
      }
      const session = store.appendTranscript(id, delta)
      const prepPoints = session.prepPoints || []
      const { cues } = await composeCues({ prepPoints, transcript: session.transcript, openaiChat })
      store.setCues(id, cues)
      res.json({ transcript: delta, cues })
    } catch (err) {
      res.status(502).json({ error: err.message || 'chunk_failed' })
    }
  })

  router.post('/meeting/:id/end', async (req, res) => {
    const id = req.params.id
    const session = store.get(id)
    if (!session) return res.status(404).json({ error: 'unknown_session' })
    const { summary, actionItems, nextSteps } = await composeMeetingSummary({
      accountName: session.accountId,
      transcript: session.transcript,
      openaiChat,
    })
    let recordId = null
    let saved = false
    try {
      const record = buildMeetingNoteRecord({
        accountId: session.accountId,
        prepId: session.prepId,
        transcript: session.transcript,
        summary,
        actionItems,
        nextSteps,
        startedAt: session.startedAt,
      })
      const out = await writeMeetingNote({ createRecord, record })
      recordId = out.id
      saved = true
    } catch (err) {
      saved = false
    }
    store.end(id)
    res.json({ summary, actionItems, nextSteps, recordId, saved })
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/routes-meeting.test.js` → PASS.

- [ ] **Step 5: Wire into server.js**

In `proxy/server.js`, add the import next to the other router imports (top of file):
```js
import { makeMeetingRouter } from './routes/meeting.js'
import { createMeetingStore } from './lib/meeting/session.js'
import { composeTalkingPoints } from './lib/detail/talkingPoints.js'
```
Immediately BEFORE `const app = express()` (after `createRecord` is defined), add the shared store + prep-context loader:
```js
const meetingStore = createMeetingStore()

async function loadPrepContext(accountId) {
  try {
    const prepRows = await runQuery(
      `SELECT Id FROM Meeting_Prep__c WHERE Account__c = '${accountId}' ORDER BY CreatedDate DESC LIMIT 1`,
    )
    const prepId = prepRows?.[0]?.Id ?? null
    const bundle = await gatherAccountData({ runQuery, accountId })
    const { points } = await composeTalkingPoints({ bundle, openaiChat })
    return { prepId, prepPoints: points || [] }
  } catch {
    return { prepId: null, prepPoints: [] }
  }
}
```
NOTE: `gatherAccountData` is imported in `server.js` if not already — verify the existing import list; it is used by the detail router indirectly but may need adding here: `import { gatherAccountData } from './lib/prep/gather.js'` (add only if not already imported).
Then mount after the detail router (`app.use(makeDetailRouter(...))`), before `express.static`:
```js
app.use(
  makeMeetingRouter({
    transcribePcm,
    openaiChat,
    createRecord,
    store: meetingStore,
    loadPrepContext,
  }),
)
```

- [ ] **Step 6: Verify full suite + boot smoke**

Run: `cd proxy && npm test` (all pass), then `node --check server.js`.
Best-effort boot: `cd proxy && PORT=3997 SF_TARGET_ORG=evenTest node --env-file=.env server.js &` then `sleep 3 && curl -s localhost:3997/health && kill %1`. If the sandbox blocks it, skip and note it — `node --check` + the offline route test are the required gates.

- [ ] **Step 7: Commit**

```bash
cd proxy && git add routes/meeting.js test/routes-meeting.test.js server.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add /meeting start/chunk/end routes + server wiring"
```

---

### Task 6: Salesforce Meeting_Note__c object + permission set

**Files:**
- Create: `salesforce/force-app/main/default/objects/Meeting_Note__c/Meeting_Note__c.object-meta.xml`
- Create: `salesforce/force-app/main/default/objects/Meeting_Note__c/fields/Account__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Meeting_Prep__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Meeting_Date__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Transcript__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Summary__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Action_Items__c.field-meta.xml`
- Create: `.../Meeting_Note__c/fields/Next_Steps__c.field-meta.xml`
- Modify: `salesforce/force-app/main/default/permissionsets/Meeting_Prep_Access.permissionset-meta.xml`

**Interfaces:**
- Produces: deployable `Meeting_Note__c` with the fields the record builder writes (`Account__c`, `Meeting_Prep__c`, `Meeting_Date__c`, `Transcript__c`, `Summary__c`, `Action_Items__c`, `Next_Steps__c`). This task authors metadata only; deployment happens in Step 4.

- [ ] **Step 1: Author the object + fields**

Create `Meeting_Note__c.object-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Meeting Note</label>
    <pluralLabel>Meeting Notes</pluralLabel>
    <nameField>
        <type>AutoNumber</type>
        <label>Note Number</label>
        <displayFormat>Note-{0000}</displayFormat>
    </nameField>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
```
Create `fields/Account__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <label>Account</label>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
    <relationshipLabel>Meeting Notes</relationshipLabel>
    <relationshipName>Meeting_Notes</relationshipName>
    <required>false</required>
</CustomField>
```
Create `fields/Meeting_Prep__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Meeting_Prep__c</fullName>
    <label>Meeting Prep</label>
    <type>Lookup</type>
    <referenceTo>Meeting_Prep__c</referenceTo>
    <relationshipLabel>Meeting Notes</relationshipLabel>
    <relationshipName>Meeting_Notes</relationshipName>
    <required>false</required>
</CustomField>
```
Create `fields/Meeting_Date__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Meeting_Date__c</fullName>
    <label>Meeting Date</label>
    <type>DateTime</type>
</CustomField>
```
Create each of `Transcript__c`, `Summary__c`, `Action_Items__c`, `Next_Steps__c` as LongTextArea, e.g. `fields/Transcript__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Transcript__c</fullName>
    <label>Transcript</label>
    <type>LongTextArea</type>
    <length>131072</length>
    <visibleLines>20</visibleLines>
</CustomField>
```
Repeat for `Summary__c` (label "Summary"), `Action_Items__c` (label "Action Items"), `Next_Steps__c` (label "Next Steps") — same `LongTextArea`/`length`/`visibleLines`, changing only `fullName` and `label`.

- [ ] **Step 2: Extend the permission set**

In `Meeting_Prep_Access.permissionset-meta.xml`, add a second `<objectPermissions>` block for `Meeting_Note__c` (same flags as the existing one) and `<fieldPermissions>` (readable+editable) for each of: `Meeting_Note__c.Account__c`, `Meeting_Note__c.Meeting_Prep__c`, `Meeting_Note__c.Meeting_Date__c`, `Meeting_Note__c.Transcript__c`, `Meeting_Note__c.Summary__c`, `Meeting_Note__c.Action_Items__c`, `Meeting_Note__c.Next_Steps__c`. Insert before the closing `</PermissionSet>`:
```xml
    <objectPermissions>
        <object>Meeting_Note__c</object>
        <allowRead>true</allowRead>
        <allowCreate>true</allowCreate>
        <allowEdit>true</allowEdit>
        <allowDelete>true</allowDelete>
        <viewAllRecords>true</viewAllRecords>
        <modifyAllRecords>true</modifyAllRecords>
    </objectPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Account__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Meeting_Prep__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Meeting_Date__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Transcript__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Summary__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Action_Items__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
    <fieldPermissions>
        <field>Meeting_Note__c.Next_Steps__c</field>
        <readable>true</readable>
        <editable>true</editable>
    </fieldPermissions>
```

- [ ] **Step 3: Validate XML locally**

Run: `cd salesforce && ls -R force-app/main/default/objects/Meeting_Note__c`. Confirm all 8 files exist. (No lint tool; visual check that each XML has a single root element.)

- [ ] **Step 4: Deploy to the org (controller-run — see handoff note)**

Deployment touches the live org and is done by the controller, not inside the sandboxed subagent:
```bash
cd salesforce && sf project deploy start \
  --source-dir force-app/main/default/objects/Meeting_Note__c \
  --source-dir force-app/main/default/permissionsets/Meeting_Prep_Access.permissionset-meta.xml \
  --target-org evenTest
```
Then confirm: `sf sobject describe --sobject Meeting_Note__c --target-org evenTest | rg 'Transcript__c|Summary__c|Action_Items__c|Next_Steps__c'`.

- [ ] **Step 5: Commit (metadata only)**

```bash
cd /Users/osayed/EvenRealities && git add salesforce/force-app/main/default/objects/Meeting_Note__c salesforce/force-app/main/default/permissionsets/Meeting_Prep_Access.permissionset-meta.xml
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add Meeting_Note__c object + permission set access"
```

---

### Task 7: Glasses app meeting mode

**Files:**
- Modify: `app/src/main.ts`

**Interfaces:**
- Consumes: `POST /meeting/start` → `{ sessionId, cues }`; `POST /meeting/:id/chunk` → `{ transcript, cues }`; `POST /meeting/:id/end` → `{ summary, actionItems, nextSteps, recordId, saved }`. (Use the existing `postJson` helper.)
- Produces: `meeting`/`meetingSummary` views, `startMeeting`, `flushMeetingChunk`, `endMeeting`, and pure `renderMeeting`/`renderMeetingSummary`.

- [ ] **Step 1: Add types, state, and pure render helpers**

In `app/src/main.ts`, add to the `View` union: `'meeting' | 'meetingSummary'` (find the `type View =` declaration and extend it).
Add interfaces near the others:
```ts
interface MeetingStart { sessionId: string; cues: string[] }
interface MeetingChunk { transcript: string; cues: string[] }
interface MeetingEnd { summary: string; actionItems: string[]; nextSteps: string[]; recordId: string | null; saved: boolean }
```
Add state near the other `let` state (after `detailAccountId`):
```ts
let meetingSessionId: string | null = null
let meetingCues: string[] = []
let meetingTranscriptTail = ''
let meetingStartMs = 0
let meetingAccountName = ''
let flushTimer: ReturnType<typeof setInterval> | null = null
const MEETING_FLUSH_MS = 20000
```
Add pure helpers (near `renderDetail`):
```ts
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function renderMeeting(o: { accountName: string; elapsedMs: number; cues: string[]; transcriptTail: string }): string {
  const head = `● REC ${fmtElapsed(o.elapsedMs)}   ${o.accountName}\n`
  const cues = o.cues.length
    ? '\nLive cues\n' + o.cues.map((c) => ` • ${c}`).join('\n') + '\n'
    : '\nLive cues\n (listening…)\n'
  const tail = o.transcriptTail ? `\n"${o.transcriptTail}"\n` : ''
  return `${head}${cues}${tail}\nTap: end & save   x2: discard`
}

function renderMeetingSummary(r: MeetingEnd, accountName: string): string {
  const ai = r.actionItems.length ? '\nAction items\n' + r.actionItems.map((x) => ` • ${x}`).join('\n') + '\n' : ''
  const ns = r.nextSteps.length ? '\nNext steps\n' + r.nextSteps.map((x) => ` • ${x}`).join('\n') + '\n' : ''
  const status = r.saved ? 'Saved to Salesforce ✓' : 'NOT saved — Salesforce write failed'
  return `Meeting ${r.saved ? 'saved' : 'ended'}  ${accountName}\n\nSummary\n ${r.summary}\n${ai}${ns}\n${status} · Tap: back`
}
```

- [ ] **Step 2: Add the meeting lifecycle functions**

Add near `openSelectedAccount`:
```ts
async function startMeeting(account: Account) {
  if (busy || recording) return
  busy = true
  try {
    const s = await postJson<MeetingStart>('/meeting/start', { accountId: account.id })
    meetingSessionId = s.sessionId
    meetingCues = s.cues || []
    meetingTranscriptTail = ''
    meetingStartMs = Date.now()
    meetingAccountName = account.name
    view = 'meeting'
    recording = true
    pcmChunks = []
    await bridge.audioControl(true, AudioInputSource.Glasses)
    await renderMeetingScreen()
    flushTimer = setInterval(() => { void flushMeetingChunk() }, MEETING_FLUSH_MS)
  } catch (err) {
    await setText(`${account.name}\n\nCould not start meeting\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_MEETING_START_ERROR', err)
  } finally {
    busy = false
  }
}

async function renderMeetingScreen() {
  await setText(renderMeeting({
    accountName: meetingAccountName,
    elapsedMs: Date.now() - meetingStartMs,
    cues: meetingCues,
    transcriptTail: meetingTranscriptTail,
  }))
}

function snapshotPcm(): Uint8Array {
  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length }
  pcmChunks = []
  return merged
}

async function flushMeetingChunk() {
  if (!meetingSessionId || view !== 'meeting') return
  const merged = snapshotPcm()
  try {
    if (merged.length > 0) {
      const audioBase64 = uint8ToBase64(merged)
      const r = await postJson<MeetingChunk>(`/meeting/${meetingSessionId}/chunk`, { audioBase64 })
      meetingCues = r.cues || meetingCues
      if (r.transcript) meetingTranscriptTail = r.transcript.slice(-120)
    }
  } catch (err) {
    console.error('APP_MEETING_CHUNK_ERROR', err)
  }
  if (view === 'meeting') await renderMeetingScreen()
}

async function endMeeting(save: boolean) {
  if (!meetingSessionId) return
  const sessionId = meetingSessionId
  const accountName = meetingAccountName
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  recording = false
  try { await bridge.audioControl(false) } catch { /* ignore */ }
  busy = true
  try {
    if (save) {
      const merged = snapshotPcm()
      if (merged.length > 0) {
        try {
          await postJson<MeetingChunk>(`/meeting/${sessionId}/chunk`, { audioBase64: uint8ToBase64(merged) })
        } catch { /* best-effort final chunk */ }
      }
      await setText(`${accountName}\n\nSummarizing & saving…`)
      const r = await postJson<MeetingEnd>(`/meeting/${sessionId}/end`, {})
      view = 'meetingSummary'
      await setText(renderMeetingSummary(r, accountName))
    } else {
      view = 'accounts'
      meetingSessionId = null
      await showAccounts()
    }
  } catch (err) {
    view = 'meetingSummary'
    await setText(`${accountName}\n\nMeeting ended but summary failed\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_MEETING_END_ERROR', err)
  } finally {
    meetingSessionId = null
    busy = false
  }
}
```

- [ ] **Step 3: Wire gestures**

In `onSingleTap`, add handling for the new views. Change the top of `onSingleTap` so meeting views are handled first:
```ts
async function onSingleTap() {
  if (view === 'meeting') { await endMeeting(true); return }
  if (view === 'meetingSummary') { await showAccounts(); return }
  if (view === 'listening') {
    if (captureMode === 'prep') await stopListeningAndPrep()
    else await stopListeningAndSearch()
    return
  }
  // ...existing body unchanged...
```
In `onDoubleTap`, start a meeting from the detail view, and discard from a meeting:
```ts
async function onDoubleTap() {
  if (view === 'meeting') { await endMeeting(false); return }
  if (view === 'listening') { await cancelListening(); return }
  if (view === 'detail') {
    const account = accounts[selected - 1]
    if (account) await startMeeting(account)
    return
  }
  await startListening()
}
```
NOTE: verify the exact current bodies of `onSingleTap`/`onDoubleTap` before editing and preserve all existing branches; only prepend the new view handlers.

- [ ] **Step 4: Build**

Run: `cd app && npm run build`
Expected: `tsc && vite build` exit 0, no type errors. Fix any (e.g., ensure `postJson`, `uint8ToBase64`, `AudioInputSource`, `showAccounts` are already imported/defined — they are used elsewhere in the file).

- [ ] **Step 5: Commit**

```bash
cd /Users/osayed/EvenRealities && git add app/src/main.ts
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: glasses meeting mode (live cues, capture, end-to-summary)"
```

---

## Self-Review

**Spec coverage:**
- Session lifecycle → Task 1. ✓
- Real-time cues (LLM + prep fallback, grounded in prep points + transcript) → Task 2 + Task 5 (`/chunk`). ✓
- Continuous capture / ~20s flush → Task 7 (`MEETING_FLUSH_MS`, `flushMeetingChunk`, mic stays on). ✓
- Summary + action items + next steps → Task 3 + Task 5 (`/end`). ✓
- Write to `Meeting_Note__c` linked to Account (+ optional prep) → Task 4 + Task 6 (metadata) + Task 5 (`loadPrepContext` sets `prepId`). ✓
- Cues seeded from prep context via `composeTalkingPoints` → Task 5 (`loadPrepContext`). ✓
- Gestures (detail double-tap start; meeting single=end/double=discard; summary tap=back) → Task 7. ✓
- Error handling (dropped chunk continues; write failure → `saved:false`; unknown session 404; mic-fail message) → Task 5 + Task 7. ✓
- Testing (node:test units + offline routes; clean app build; live check) → each task + handoff. ✓

**Placeholder scan:** none — all steps contain concrete code/commands. The two "NOTE: verify" lines instruct verifying existing code before editing, not deferred work.

**Type consistency:** `MeetingStart`/`MeetingChunk`/`MeetingEnd` (Task 7) match the router outputs in Task 5. `createMeetingStore` API (Task 1) matches consumption in Task 5. `composeCues`/`composeMeetingSummary` signatures (Tasks 2/3) match Task 5 calls. `buildMeetingNoteRecord` fields (Task 4) match the `Meeting_Note__c` metadata (Task 6). `loadPrepContext` returns `{prepId, prepPoints}` consumed in Task 5.

**Prep-points grounding:** the session stores `prepPoints` (Task 1), so `/chunk` re-grounds cues via `session.prepPoints` (Task 5) without any side storage.
