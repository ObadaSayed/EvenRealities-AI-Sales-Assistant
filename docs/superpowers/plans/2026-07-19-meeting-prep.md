# Meeting Prep (Subsystem A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A salesperson speaks a prep request into the G2 glasses; the Node proxy gathers real Salesforce CRM data plus mocked external context, composes a brief with OpenAI, and writes it to a new `Meeting_Prep__c` record linked to the Account, with the glasses showing a short confirmation.

**Architecture:** Extend the existing Express + jsforce proxy with small, dependency-injected `lib/prep/*` modules and a `routes/prep.js` router. `POST /prep` transcribes audio, parses intent, creates an in-memory job, and returns immediately; a background runner gathers CRM data, builds mock sections, composes the brief, and writes the record. The glasses app adds a "Prep meeting" view that reuses mic capture and polls `GET /prep/:jobId`.

**Tech Stack:** Node 20 (ESM), Express 4, jsforce 3, OpenAI Whisper + chat (REST via `fetch`), Node built-in `node:test`, Even Hub SDK (Vite + TS), Salesforce metadata via `sf` CLI.

## Global Constraints

- Node runtime: `>=20`, ESM only (`"type": "module"`). Copy verbatim from `proxy/package.json`.
- No new npm dependencies for tests — use Node built-in `node:test` and `node:assert`.
- Never dead-end the demo: on OpenAI failure, fall back to a deterministic template brief and still write the record. On other failures, set job `failed` with a short message.
- Salesforce auth reuses the existing pattern: `SFDX_AUTH_URL` (jsforce) on Heroku, `sf` CLI session locally. The org is already authenticated; hosting is Heroku.
- Secrets (`proxy/.env`) stay untracked (already in root `.gitignore`).
- Custom object API name: `Meeting_Prep__c`. Fields: `Account__c` (Lookup Account), `Brief__c` (Long Text Area, rich), `Meeting_Date__c` (Date), `Attendees__c` (Long Text Area), `Status__c` (Picklist: Ready/Failed/Draft), `Source__c` (Text 50), `Transcript__c` (Text 255).
- All new proxy modules take their I/O dependencies as injected parameters (a `runQuery` function, an `openaiChat` function, a `createRecord` function) so tests run offline with stubs.
- Commit after every task with a Conventional Commit message. Use the inline git identity already established for this repo if none is configured.

---

## File Structure

```
proxy/
  server.js                 (modify: import text helpers; mount prep router; add createRecord)
  lib/
    text.js                 (new: extractAccountName, normalizeName — moved from server.js)
    prep/
      intent.js             (new: parsePrepIntent)
      queries.js            (new: SOQL string builders)
      gather.js             (new: gatherAccountData)
      mock.js               (new: mockRfps, mockAttendeeResearch, mockCalendar)
      compose.js            (new: buildPrompt, renderTemplateBrief, composeBrief)
      record.js             (new: buildMeetingPrepRecord, writeMeetingPrep)
      jobs.js               (new: in-memory job store)
      runner.js             (new: runPrepJob orchestration)
  routes/
    prep.js                 (new: makePrepRouter(deps))
  test/
    text.test.js
    intent.test.js
    queries.test.js
    gather.test.js
    mock.test.js
    compose.test.js
    record.test.js
    jobs.test.js
    runner.test.js
    routes-prep.test.js
salesforce/                 (new SFDX project for metadata)
  sfdx-project.json
  force-app/main/default/objects/Meeting_Prep__c/Meeting_Prep__c.object-meta.xml
  force-app/main/default/objects/Meeting_Prep__c/fields/*.field-meta.xml
app/
  src/main.ts               (modify: add "Prep meeting" view + poll loop)
```

---

### Task 1: Test harness + extract shared text helpers

**Files:**
- Create: `proxy/lib/text.js`
- Create: `proxy/test/text.test.js`
- Modify: `proxy/package.json` (add `test` script)
- Modify: `proxy/server.js` (remove local `extractAccountName`/`normalizeName`, import from `lib/text.js`)

**Interfaces:**
- Produces: `extractAccountName(text: string): string` and `normalizeName(s: string): string` from `proxy/lib/text.js`.

- [ ] **Step 1: Add the test script to `proxy/package.json`**

Change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test** — `proxy/test/text.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractAccountName, normalizeName } from '../lib/text.js'

test('extractAccountName pulls name after a connector word', () => {
  assert.equal(extractAccountName('prep me for the Omega meeting'), 'Omega')
  assert.equal(extractAccountName('show me details about NetAssist'), 'NetAssist')
})

test('extractAccountName strips leading command phrases', () => {
  assert.equal(extractAccountName('open Acme'), 'Acme')
})

test('normalizeName lowercases and strips non-alphanumerics', () => {
  assert.equal(normalizeName('Net Assist, Inc.'), 'netassistinc')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — `Cannot find module '../lib/text.js'`.

- [ ] **Step 4: Create `proxy/lib/text.js`** (move the exact logic currently in `server.js`)

```js
// Pull the likely account name out of a natural-language request.
export function extractAccountName(text) {
  let s = String(text || '').trim()
  const conn = s.match(/\b(?:about|for|on|of|regarding|called|named|with)\s+(.+)$/i)
  if (conn) {
    s = conn[1]
  } else {
    s = s.replace(
      /^\s*(?:hey\s+\w+[,\s]+)?(?:show me|show|tell me|give me|find me|find|get me|get|search for|search|look up|pull up|open|prep(?:are)?(?: me)?|what(?:'s| is| are)?|whats|details? of|details? about|info(?:rmation)? about)\s+/i,
      '',
    )
  }
  s = s
    .replace(/\b(?:the|all|my|any|some)\b/gi, ' ')
    .replace(/\b(?:details?|information|info|account|accounts|opportunit(?:y|ies)|opps|pipeline|deals?|records?|meeting|please|thanks?|thank you)\b/gi, ' ')
    .replace(/[^\w\s,&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,;:!?'"&-]+|[\s.,;:!?'"&-]+$/g, '')
    .trim()
  return s
}

export const normalizeName = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
```

- [ ] **Step 5: Update `proxy/server.js` to import from `lib/text.js`**

Remove the local `extractAccountName` function (currently around lines 171–195) and the local `normalizeName` (currently line 197). Add near the top imports:

```js
import { extractAccountName, normalizeName } from './lib/text.js'
```

- [ ] **Step 6: Run tests + start the server to confirm no regression**

Run: `cd proxy && npm test`
Expected: PASS (3 tests).
Run: `cd proxy && SF_TARGET_ORG=evenTest node -e "import('./server.js')" & sleep 2 && curl -s localhost:3000/health && kill %1`
Expected: `/health` JSON prints (proves the import refactor didn't break boot).

- [ ] **Step 7: Commit**

```bash
git add proxy/lib/text.js proxy/test/text.test.js proxy/package.json proxy/server.js
git commit -m "refactor: extract text helpers into lib/text.js with tests"
```

---

### Task 2: Prep intent parser

**Files:**
- Create: `proxy/lib/prep/intent.js`
- Create: `proxy/test/intent.test.js`

**Interfaces:**
- Consumes: `extractAccountName(text)` from `../text.js`.
- Produces: `parsePrepIntent(text: string): { isPrep: boolean, accountName: string | null }`.

- [ ] **Step 1: Write the failing test** — `proxy/test/intent.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrepIntent } from '../lib/prep/intent.js'

test('detects prep intent and extracts account', () => {
  assert.deepEqual(parsePrepIntent('prep me for the Omega meeting'), {
    isPrep: true,
    accountName: 'Omega',
  })
  assert.deepEqual(parsePrepIntent('prepare a brief for NetAssist'), {
    isPrep: true,
    accountName: 'NetAssist',
  })
})

test('non-prep phrasing returns isPrep false', () => {
  assert.equal(parsePrepIntent('show me details about Acme').isPrep, false)
})

test('prep with no account yields null accountName', () => {
  assert.deepEqual(parsePrepIntent('prep me for the meeting'), {
    isPrep: true,
    accountName: null,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — `Cannot find module '../lib/prep/intent.js'`.

- [ ] **Step 3: Create `proxy/lib/prep/intent.js`**

```js
import { extractAccountName } from '../text.js'

const PREP_RE = /\b(prep|prepare|prepping|briefing|brief me|get me ready|meeting notes|prep notes)\b/i

export function parsePrepIntent(text) {
  const s = String(text || '')
  const isPrep = PREP_RE.test(s)
  const name = extractAccountName(s)
  return { isPrep, accountName: name && name.length ? name : null }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS (intent tests + prior tests).

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/intent.js proxy/test/intent.test.js
git commit -m "feat: add prep intent parser"
```

---

### Task 3: SOQL query builders

**Files:**
- Create: `proxy/lib/prep/queries.js`
- Create: `proxy/test/queries.test.js`

**Interfaces:**
- Consumes: `soqlEscape(value)` — pass it in (do not import from server.js). Signature: `(value: string) => string`.
- Produces: pure string builders:
  - `accountByIdSoql(id: string): string`
  - `opportunitiesSoql(accountId: string): string`
  - `casesSoql(accountId: string): string`
  - `contactsSoql(accountId: string): string`

- [ ] **Step 1: Write the failing test** — `proxy/test/queries.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountByIdSoql,
  opportunitiesSoql,
  casesSoql,
  contactsSoql,
} from '../lib/prep/queries.js'

test('accountByIdSoql selects core fields for the id', () => {
  const q = accountByIdSoql('001AAA')
  assert.match(q, /FROM Account/)
  assert.match(q, /WHERE Id = '001AAA'/)
})

test('opportunitiesSoql filters by AccountId', () => {
  assert.match(opportunitiesSoql('001AAA'), /WHERE AccountId = '001AAA'/)
})

test('casesSoql filters by AccountId and selects status', () => {
  const q = casesSoql('001AAA')
  assert.match(q, /FROM Case/)
  assert.match(q, /Status/)
})

test('contactsSoql filters by AccountId', () => {
  assert.match(contactsSoql('001AAA'), /FROM Contact/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/queries.js`**

```js
export function accountByIdSoql(id) {
  return (
    `SELECT Id, Name, Industry, Type, Website, Phone, AnnualRevenue, ` +
    `BillingCity, BillingState, Description ` +
    `FROM Account WHERE Id = '${id}' LIMIT 1`
  )
}

export function opportunitiesSoql(accountId) {
  return (
    `SELECT Id, Name, Amount, StageName, CloseDate, IsClosed, IsWon ` +
    `FROM Opportunity WHERE AccountId = '${accountId}' ` +
    `ORDER BY CloseDate DESC NULLS LAST LIMIT 25`
  )
}

export function casesSoql(accountId) {
  return (
    `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, IsClosed ` +
    `FROM Case WHERE AccountId = '${accountId}' ` +
    `ORDER BY CreatedDate DESC LIMIT 25`
  )
}

export function contactsSoql(accountId) {
  return (
    `SELECT Id, Name, Title, Email, Department ` +
    `FROM Contact WHERE AccountId = '${accountId}' ` +
    `ORDER BY CreatedDate DESC LIMIT 15`
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/queries.js proxy/test/queries.test.js
git commit -m "feat: add SOQL builders for prep data gather"
```

---

### Task 4: gatherAccountData

**Files:**
- Create: `proxy/lib/prep/gather.js`
- Create: `proxy/test/gather.test.js`

**Interfaces:**
- Consumes: injected `runQuery(soql: string): Promise<record[]>`; the builders from `./queries.js`.
- Produces: `gatherAccountData({ runQuery, accountId }): Promise<{ account, opportunities, cases, contacts, metrics }>` where `metrics = { totalPipeline, openPipeline, openCaseCount, wonCount }`.

- [ ] **Step 1: Write the failing test** — `proxy/test/gather.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatherAccountData } from '../lib/prep/gather.js'

function fakeRunQuery(map) {
  return async (soql) => {
    if (/FROM Account/.test(soql)) return map.account
    if (/FROM Opportunity/.test(soql)) return map.opps
    if (/FROM Case/.test(soql)) return map.cases
    if (/FROM Contact/.test(soql)) return map.contacts
    return []
  }
}

test('gatherAccountData aggregates records and metrics', async () => {
  const runQuery = fakeRunQuery({
    account: [{ Id: '001', Name: 'Omega', Industry: 'Tech' }],
    opps: [
      { Id: 'o1', Name: 'Deal A', Amount: 100, StageName: 'Prospecting', IsClosed: false, IsWon: false },
      { Id: 'o2', Name: 'Deal B', Amount: 50, StageName: 'Closed Won', IsClosed: true, IsWon: true },
    ],
    cases: [
      { Id: 'c1', CaseNumber: '0001', Subject: 'Late delivery', Status: 'New', IsClosed: false },
    ],
    contacts: [{ Id: 'p1', Name: 'Jane Doe', Title: 'VP Ops' }],
  })

  const data = await gatherAccountData({ runQuery, accountId: '001' })
  assert.equal(data.account.name, 'Omega')
  assert.equal(data.opportunities.length, 2)
  assert.equal(data.metrics.totalPipeline, 150)
  assert.equal(data.metrics.openPipeline, 100)
  assert.equal(data.metrics.openCaseCount, 1)
  assert.equal(data.contacts[0].name, 'Jane Doe')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/gather.js`**

```js
import {
  accountByIdSoql,
  opportunitiesSoql,
  casesSoql,
  contactsSoql,
} from './queries.js'

export async function gatherAccountData({ runQuery, accountId }) {
  const [accRecs, oppRecs, caseRecs, contactRecs] = await Promise.all([
    runQuery(accountByIdSoql(accountId)),
    runQuery(opportunitiesSoql(accountId)),
    runQuery(casesSoql(accountId)),
    runQuery(contactsSoql(accountId)),
  ])

  const a = accRecs[0] || { Id: accountId, Name: '(unknown)' }
  const account = {
    id: a.Id,
    name: a.Name,
    industry: a.Industry ?? null,
    type: a.Type ?? null,
    website: a.Website ?? null,
    phone: a.Phone ?? null,
    annualRevenue: a.AnnualRevenue ?? null,
    city: a.BillingCity ?? null,
    state: a.BillingState ?? null,
    description: a.Description ?? null,
  }

  const opportunities = oppRecs.map((o) => ({
    id: o.Id,
    name: o.Name,
    amount: o.Amount ?? 0,
    stage: o.StageName,
    closeDate: o.CloseDate ?? null,
    isClosed: !!o.IsClosed,
    isWon: !!o.IsWon,
  }))

  const cases = caseRecs.map((c) => ({
    id: c.Id,
    number: c.CaseNumber,
    subject: c.Subject,
    status: c.Status,
    priority: c.Priority ?? null,
    createdDate: c.CreatedDate ?? null,
    isClosed: !!c.IsClosed,
  }))

  const contacts = contactRecs.map((p) => ({
    id: p.Id,
    name: p.Name,
    title: p.Title ?? null,
    email: p.Email ?? null,
    department: p.Department ?? null,
  }))

  const totalPipeline = opportunities.reduce((s, o) => s + (o.amount || 0), 0)
  const openPipeline = opportunities
    .filter((o) => !o.isClosed)
    .reduce((s, o) => s + (o.amount || 0), 0)
  const openCaseCount = cases.filter((c) => !c.isClosed).length
  const wonCount = opportunities.filter((o) => o.isWon).length

  return {
    account,
    opportunities,
    cases,
    contacts,
    metrics: { totalPipeline, openPipeline, openCaseCount, wonCount },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/gather.js proxy/test/gather.test.js
git commit -m "feat: add gatherAccountData CRM aggregation"
```

---

### Task 5: Mock providers (docs / attendee research / calendar)

**Files:**
- Create: `proxy/lib/prep/mock.js`
- Create: `proxy/test/mock.test.js`

**Interfaces:**
- Produces:
  - `mockRfps(account: {name}): { title, date, status }[]`
  - `mockAttendeeResearch(contacts: {name,title}[]): { name, title, summary, career: string[], education: string }[]`
  - `mockCalendar(account: {name}): { subject, date, location }`
- All are deterministic (seeded off names) and each research entry is labelled illustrative.

- [ ] **Step 1: Write the failing test** — `proxy/test/mock.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockRfps, mockAttendeeResearch, mockCalendar } from '../lib/prep/mock.js'

test('mockRfps returns a non-empty deterministic list', () => {
  const a = mockRfps({ name: 'Omega' })
  const b = mockRfps({ name: 'Omega' })
  assert.ok(a.length >= 1)
  assert.deepEqual(a, b)
  assert.ok(a[0].title.includes('Omega'))
})

test('mockAttendeeResearch produces one illustrative entry per contact', () => {
  const res = mockAttendeeResearch([{ name: 'Jane Doe', title: 'VP Ops' }])
  assert.equal(res.length, 1)
  assert.equal(res[0].name, 'Jane Doe')
  assert.match(res[0].summary, /illustrative/i)
  assert.ok(Array.isArray(res[0].career))
})

test('mockCalendar returns a subject referencing the account', () => {
  const cal = mockCalendar({ name: 'Omega' })
  assert.match(cal.subject, /Omega/)
  assert.ok(cal.date)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/mock.js`**

```js
// Deterministic, clearly-illustrative stand-ins for sources that are not
// live-integrated in subsystem A (documents/RFPs, attendee web research,
// calendar). Seeded off names so output is stable across runs and tests.

function hash(str) {
  let h = 0
  for (let i = 0; i < String(str).length; i++) {
    h = (h * 31 + String(str).charCodeAt(i)) >>> 0
  }
  return h
}

function daysFromNow(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function mockRfps(account) {
  const name = account?.name || 'Account'
  const h = hash(name)
  const kinds = ['Managed Services', 'Platform Migration', 'Support Renewal']
  return [
    { title: `${name} — ${kinds[h % kinds.length]} RFP`, date: daysFromNow(-(10 + (h % 20))), status: 'Under review' },
    { title: `${name} — Annual Procurement RFP`, date: daysFromNow(-(45 + (h % 30))), status: 'Submitted' },
  ]
}

export function mockAttendeeResearch(contacts) {
  const list = Array.isArray(contacts) ? contacts : []
  const firms = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Hooli']
  const schools = ['MIT', 'Stanford', 'INSEAD', 'LBS', 'Wharton']
  return list.map((c) => {
    const h = hash(c.name || 'contact')
    const years = 3 + (h % 12)
    return {
      name: c.name,
      title: c.title || 'Unknown role',
      summary: `Illustrative research (mock): ${c.name} has ~${years} years in ${c.title || 'their role'}.`,
      career: [
        `Currently ${c.title || 'role'} (${years} yrs)`,
        `Previously at ${firms[h % firms.length]}`,
        `Earlier at ${firms[(h + 2) % firms.length]}`,
      ],
      education: `${schools[h % schools.length]}`,
    }
  })
}

export function mockCalendar(account) {
  const name = account?.name || 'Account'
  return {
    subject: `${name} — Quarterly Business Review`,
    date: daysFromNow(1),
    location: 'Video call',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/mock.js proxy/test/mock.test.js
git commit -m "feat: add deterministic mock providers for docs/research/calendar"
```

---

### Task 6: Compose brief (OpenAI) with deterministic template fallback

**Files:**
- Create: `proxy/lib/prep/compose.js`
- Create: `proxy/test/compose.test.js`

**Interfaces:**
- Consumes: injected `openaiChat({ system, user }): Promise<string>` (throws on failure).
- Produces:
  - `buildPrompt(bundle): { system: string, user: string }`
  - `renderTemplateBrief(bundle): string`
  - `composeBrief({ bundle, openaiChat }): Promise<{ brief: string, source: 'openai' | 'template' }>`
- `bundle` shape: `{ account, opportunities, cases, contacts, metrics, rfps, research, calendar }`.

- [ ] **Step 1: Write the failing test** — `proxy/test/compose.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, renderTemplateBrief, composeBrief } from '../lib/prep/compose.js'

const bundle = {
  account: { name: 'Omega', industry: 'Tech' },
  opportunities: [{ name: 'Deal A', amount: 100, stage: 'Prospecting', isClosed: false }],
  cases: [{ number: '0001', subject: 'Late delivery', status: 'New', isClosed: false }],
  contacts: [{ name: 'Jane Doe', title: 'VP Ops' }],
  metrics: { totalPipeline: 100, openPipeline: 100, openCaseCount: 1, wonCount: 0 },
  rfps: [{ title: 'Omega — Support Renewal RFP', date: '2026-07-01', status: 'Submitted' }],
  research: [{ name: 'Jane Doe', title: 'VP Ops', summary: 'Illustrative research (mock).', career: ['x'], education: 'MIT' }],
  calendar: { subject: 'Omega — QBR', date: '2026-07-20', location: 'Video call' },
}

test('buildPrompt includes account name and the sections', () => {
  const { system, user } = buildPrompt(bundle)
  assert.match(system, /sales/i)
  assert.match(user, /Omega/)
  assert.match(user, /Late delivery/)
})

test('renderTemplateBrief produces sectioned text without an LLM', () => {
  const brief = renderTemplateBrief(bundle)
  assert.match(brief, /Omega/)
  assert.match(brief, /Pipeline/)
  assert.match(brief, /Complaints|Cases/)
  assert.match(brief, /Jane Doe/)
})

test('composeBrief uses openaiChat when it succeeds', async () => {
  const openaiChat = async () => 'LLM BRIEF BODY'
  const out = await composeBrief({ bundle, openaiChat })
  assert.equal(out.source, 'openai')
  assert.equal(out.brief, 'LLM BRIEF BODY')
})

test('composeBrief falls back to template when openaiChat throws', async () => {
  const openaiChat = async () => { throw new Error('boom') }
  const out = await composeBrief({ bundle, openaiChat })
  assert.equal(out.source, 'template')
  assert.match(out.brief, /Omega/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/compose.js`**

```js
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US')

export function buildPrompt(bundle) {
  const system =
    'You are a sales enablement assistant. Write a concise, well-structured ' +
    'pre-meeting brief for a salesperson. Use clear section headings and short ' +
    'bullet points. Be factual about CRM data; clearly mark any research as ' +
    'illustrative. Keep it under 400 words.'
  const user = [
    `ACCOUNT: ${bundle.account.name} (${bundle.account.industry || 'n/a'})`,
    `METRICS: total pipeline ${money(bundle.metrics.totalPipeline)}, open ${money(bundle.metrics.openPipeline)}, open cases ${bundle.metrics.openCaseCount}, won ${bundle.metrics.wonCount}`,
    `OPPORTUNITIES: ${JSON.stringify(bundle.opportunities)}`,
    `CASES (complaints): ${JSON.stringify(bundle.cases)}`,
    `RFPS/DOCS (mock): ${JSON.stringify(bundle.rfps)}`,
    `ATTENDEES + RESEARCH (mock): ${JSON.stringify(bundle.research)}`,
    `CALENDAR (mock): ${JSON.stringify(bundle.calendar)}`,
  ].join('\n\n')
  return { system, user }
}

export function renderTemplateBrief(bundle) {
  const { account, metrics, opportunities, cases, rfps, research, calendar } = bundle
  const lines = []
  lines.push(`Meeting Brief — ${account.name}`)
  if (account.industry) lines.push(`Industry: ${account.industry}`)
  lines.push('')
  lines.push(`Upcoming: ${calendar.subject} (${calendar.date}, ${calendar.location})`)
  lines.push('')
  lines.push(`Pipeline: ${money(metrics.totalPipeline)} total, ${money(metrics.openPipeline)} open, ${metrics.wonCount} won`)
  opportunities.slice(0, 6).forEach((o) => lines.push(`  - ${o.name}: ${money(o.amount)} (${o.stage})`))
  lines.push('')
  lines.push(`Complaints / Cases: ${metrics.openCaseCount} open`)
  cases.slice(0, 5).forEach((c) => lines.push(`  - #${c.number} ${c.subject} [${c.status}]`))
  lines.push('')
  lines.push('Recent RFPs / Documents (illustrative):')
  rfps.forEach((r) => lines.push(`  - ${r.title} (${r.status}, ${r.date})`))
  lines.push('')
  lines.push('Attendees (research is illustrative/mock):')
  research.forEach((p) => {
    lines.push(`  - ${p.name}, ${p.title} — ${p.education}`)
    lines.push(`    ${p.summary}`)
  })
  return lines.join('\n')
}

export async function composeBrief({ bundle, openaiChat }) {
  try {
    const { system, user } = buildPrompt(bundle)
    const brief = await openaiChat({ system, user })
    if (!brief || !String(brief).trim()) throw new Error('empty completion')
    return { brief: String(brief).trim(), source: 'openai' }
  } catch (err) {
    return { brief: renderTemplateBrief(bundle), source: 'template' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/compose.js proxy/test/compose.test.js
git commit -m "feat: add brief composition with OpenAI + template fallback"
```

---

### Task 7: Meeting_Prep record builder + writer

**Files:**
- Create: `proxy/lib/prep/record.js`
- Create: `proxy/test/record.test.js`

**Interfaces:**
- Consumes: injected `createRecord(sobject: string, fields: object): Promise<{ id: string }>`.
- Produces:
  - `buildMeetingPrepRecord({ account, brief, attendees, meetingDate, transcript, status }): object` (keyed by `Meeting_Prep__c` API field names).
  - `writeMeetingPrep({ createRecord, record }): Promise<string>` (returns the new record id).

- [ ] **Step 1: Write the failing test** — `proxy/test/record.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMeetingPrepRecord, writeMeetingPrep } from '../lib/prep/record.js'

test('buildMeetingPrepRecord maps to Meeting_Prep__c fields', () => {
  const rec = buildMeetingPrepRecord({
    account: { id: '001', name: 'Omega' },
    brief: 'BODY',
    attendees: 'Jane Doe (VP Ops)',
    meetingDate: '2026-07-20',
    transcript: 'prep me for the Omega meeting',
    status: 'Ready',
  })
  assert.equal(rec.Account__c, '001')
  assert.equal(rec.Brief__c, 'BODY')
  assert.equal(rec.Attendees__c, 'Jane Doe (VP Ops)')
  assert.equal(rec.Meeting_Date__c, '2026-07-20')
  assert.equal(rec.Status__c, 'Ready')
  assert.equal(rec.Source__c, 'glasses-voice')
  assert.equal(rec.Transcript__c, 'prep me for the Omega meeting')
})

test('writeMeetingPrep returns the created id', async () => {
  let received = null
  const createRecord = async (sobject, fields) => {
    received = { sobject, fields }
    return { id: 'a01XXXX' }
  }
  const id = await writeMeetingPrep({
    createRecord,
    record: buildMeetingPrepRecord({
      account: { id: '001', name: 'Omega' },
      brief: 'BODY', attendees: '', meetingDate: '2026-07-20',
      transcript: 't', status: 'Ready',
    }),
  })
  assert.equal(id, 'a01XXXX')
  assert.equal(received.sobject, 'Meeting_Prep__c')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/record.js`**

```js
export function buildMeetingPrepRecord({
  account,
  brief,
  attendees,
  meetingDate,
  transcript,
  status,
}) {
  return {
    Account__c: account?.id ?? null,
    Brief__c: brief ?? '',
    Attendees__c: attendees ?? '',
    Meeting_Date__c: meetingDate ?? null,
    Status__c: status ?? 'Draft',
    Source__c: 'glasses-voice',
    Transcript__c: String(transcript ?? '').slice(0, 255),
  }
}

export async function writeMeetingPrep({ createRecord, record }) {
  const res = await createRecord('Meeting_Prep__c', record)
  const id = res?.id || res?.Id
  if (!id) throw new Error('create returned no id')
  return id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/record.js proxy/test/record.test.js
git commit -m "feat: add Meeting_Prep record builder and writer"
```

---

### Task 8: In-memory job store

**Files:**
- Create: `proxy/lib/prep/jobs.js`
- Create: `proxy/test/jobs.test.js`

**Interfaces:**
- Produces a factory `createJobStore()` returning `{ create, get, update }`:
  - `create({ account, transcript }): { id, status: 'running', account, transcript }`
  - `get(id): job | undefined`
  - `update(id, patch): job` (merges patch)

- [ ] **Step 1: Write the failing test** — `proxy/test/jobs.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobStore } from '../lib/prep/jobs.js'

test('create/get/update lifecycle', () => {
  const store = createJobStore()
  const job = store.create({ account: 'Omega', transcript: 't' })
  assert.equal(job.status, 'running')
  assert.ok(job.id)
  assert.equal(store.get(job.id).account, 'Omega')
  const updated = store.update(job.id, { status: 'done', recordId: 'a01' })
  assert.equal(updated.status, 'done')
  assert.equal(store.get(job.id).recordId, 'a01')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/jobs.js`**

```js
import { randomUUID } from 'node:crypto'

export function createJobStore() {
  const jobs = new Map()
  return {
    create({ account, transcript }) {
      const id = randomUUID()
      const job = { id, status: 'running', account, transcript, createdAt: Date.now() }
      jobs.set(id, job)
      return job
    },
    get(id) {
      return jobs.get(id)
    },
    update(id, patch) {
      const existing = jobs.get(id)
      if (!existing) throw new Error(`unknown job ${id}`)
      const merged = { ...existing, ...patch }
      jobs.set(id, merged)
      return merged
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/jobs.js proxy/test/jobs.test.js
git commit -m "feat: add in-memory prep job store"
```

---

### Task 9: Prep runner orchestration

**Files:**
- Create: `proxy/lib/prep/runner.js`
- Create: `proxy/test/runner.test.js`

**Interfaces:**
- Consumes: `gatherAccountData`, `mockRfps`/`mockAttendeeResearch`/`mockCalendar`, `composeBrief`, `buildMeetingPrepRecord`/`writeMeetingPrep`; injected deps `{ findAccount, runQuery, openaiChat, createRecord }` and a `store` (from Task 8).
- Produces: `runPrepJob({ deps, store, jobId, accountName, transcript }): Promise<void>` — updates the job to `done` (with `recordId`, `summary`) or `failed` (with `error`).
- Note on `findAccount`: returns a raw Salesforce record `{ Id, Name, ... }` or `null` (matches the existing `findAccount` in `server.js`).

- [ ] **Step 1: Write the failing test** — `proxy/test/runner.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPrepJob } from '../lib/prep/runner.js'
import { createJobStore } from '../lib/prep/jobs.js'

function makeDeps() {
  return {
    findAccount: async (name) => ({ Id: '001', Name: name }),
    runQuery: async (soql) => {
      if (/FROM Account/.test(soql)) return [{ Id: '001', Name: 'Omega', Industry: 'Tech' }]
      if (/FROM Opportunity/.test(soql)) return [{ Id: 'o1', Name: 'Deal A', Amount: 100, StageName: 'Prospecting', IsClosed: false, IsWon: false }]
      if (/FROM Case/.test(soql)) return [{ Id: 'c1', CaseNumber: '0001', Subject: 'Late', Status: 'New', IsClosed: false }]
      if (/FROM Contact/.test(soql)) return [{ Id: 'p1', Name: 'Jane Doe', Title: 'VP Ops' }]
      return []
    },
    openaiChat: async () => 'LLM BRIEF',
    createRecord: async () => ({ id: 'a01ZZZ' }),
  }
}

test('runPrepJob completes and marks job done', async () => {
  const store = createJobStore()
  const job = store.create({ account: 'Omega', transcript: 't' })
  await runPrepJob({ deps: makeDeps(), store, jobId: job.id, accountName: 'Omega', transcript: 't' })
  const done = store.get(job.id)
  assert.equal(done.status, 'done')
  assert.equal(done.recordId, 'a01ZZZ')
  assert.match(done.summary, /Omega/)
})

test('runPrepJob marks failed when no account matches', async () => {
  const store = createJobStore()
  const deps = makeDeps()
  deps.findAccount = async () => null
  const job = store.create({ account: 'Nope', transcript: 't' })
  await runPrepJob({ deps, store, jobId: job.id, accountName: 'Nope', transcript: 't' })
  assert.equal(store.get(job.id).status, 'failed')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `proxy/lib/prep/runner.js`**

```js
import { gatherAccountData } from './gather.js'
import { mockRfps, mockAttendeeResearch, mockCalendar } from './mock.js'
import { composeBrief } from './compose.js'
import { buildMeetingPrepRecord, writeMeetingPrep } from './record.js'

export async function runPrepJob({ deps, store, jobId, accountName, transcript }) {
  const { findAccount, runQuery, openaiChat, createRecord } = deps
  try {
    const acc = await findAccount(accountName)
    if (!acc) {
      store.update(jobId, { status: 'failed', error: `No account found matching "${accountName}".` })
      return
    }

    const data = await gatherAccountData({ runQuery, accountId: acc.Id })
    const rfps = mockRfps(data.account)
    const research = mockAttendeeResearch(data.contacts)
    const calendar = mockCalendar(data.account)

    const bundle = { ...data, rfps, research, calendar }
    const { brief, source } = await composeBrief({ bundle, openaiChat })

    const attendees = data.contacts
      .map((c) => (c.title ? `${c.name} (${c.title})` : c.name))
      .join('; ')

    const record = buildMeetingPrepRecord({
      account: data.account,
      brief,
      attendees,
      meetingDate: calendar.date,
      transcript,
      status: 'Ready',
    })
    const recordId = await writeMeetingPrep({ createRecord, record })

    const summary =
      `${data.account.name}: ${data.opportunities.length} opps, ` +
      `${data.metrics.openCaseCount} open case(s). Brief saved (${source}).`
    store.update(jobId, { status: 'done', recordId, summary, briefSource: source })
  } catch (err) {
    store.update(jobId, { status: 'failed', error: String(err?.message || err) })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/lib/prep/runner.js proxy/test/runner.test.js
git commit -m "feat: add prep runner orchestration"
```

---

### Task 10: HTTP router + server wiring (openaiChat, createRecord)

**Files:**
- Create: `proxy/routes/prep.js`
- Create: `proxy/test/routes-prep.test.js`
- Modify: `proxy/server.js` (add `openaiChat`, `createRecord`/`getWriteConnection`, mount router)

**Interfaces:**
- Consumes: `parsePrepIntent`, `createJobStore`, `runPrepJob`, and injected deps `{ transcribePcm, findAccount, runQuery, openaiChat, createRecord }`.
- Produces: `makePrepRouter(deps): express.Router` with `POST /prep` and `GET /prep/:jobId`.

- [ ] **Step 1: Write the failing test** — `proxy/test/routes-prep.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { makePrepRouter } from '../routes/prep.js'

function startServer(deps) {
  const app = express()
  app.use(express.json())
  app.use(makePrepRouter(deps))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const baseDeps = {
  transcribePcm: async () => 'prep me for the Omega meeting',
  findAccount: async (name) => ({ Id: '001', Name: name }),
  runQuery: async (soql) => (/FROM Account/.test(soql) ? [{ Id: '001', Name: 'Omega' }] : []),
  openaiChat: async () => 'LLM BRIEF',
  createRecord: async () => ({ id: 'a01ZZZ' }),
}

test('POST /prep with text returns a jobId, GET reaches done', async () => {
  const { server, base } = await startServer(baseDeps)
  try {
    const res = await fetch(`${base}/prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'prep me for the Omega meeting' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.jobId)
    assert.equal(body.account, 'Omega')

    let job
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/prep/${body.jobId}`)
      job = await r.json()
      if (job.status !== 'running') break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(job.status, 'done')
    assert.equal(job.recordId, 'a01ZZZ')
  } finally {
    server.close()
  }
})

test('POST /prep without an account returns 400', async () => {
  const { server, base } = await startServer({
    ...baseDeps,
    transcribePcm: async () => 'prep me for the meeting',
  })
  try {
    const res = await fetch(`${base}/prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'prep me for the meeting' }),
    })
    assert.equal(res.status, 400)
  } finally {
    server.close()
  }
})

test('GET /prep/:id unknown returns 404', async () => {
  const { server, base } = await startServer(baseDeps)
  try {
    const res = await fetch(`${base}/prep/does-not-exist`)
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && npm test`
Expected: FAIL — `Cannot find module '../routes/prep.js'`.

- [ ] **Step 3: Create `proxy/routes/prep.js`**

```js
import express from 'express'
import { parsePrepIntent } from '../lib/prep/intent.js'
import { createJobStore } from '../lib/prep/jobs.js'
import { runPrepJob } from '../lib/prep/runner.js'

export function makePrepRouter(deps) {
  const router = express.Router()
  const store = createJobStore()

  router.post('/prep', async (req, res) => {
    try {
      let transcript = req.body?.text
      if (!transcript && req.body?.audioBase64) {
        transcript = await deps.transcribePcm(req.body.audioBase64)
      }
      if (!transcript) {
        res.status(400).json({ error: 'missing_input' })
        return
      }
      const { accountName } = parsePrepIntent(transcript)
      if (!accountName) {
        res.status(400).json({ error: 'no_account', transcript })
        return
      }
      const job = store.create({ account: accountName, transcript })
      res.json({ jobId: job.id, account: accountName, status: 'started' })

      // Fire-and-forget; runPrepJob catches its own errors into the job.
      void runPrepJob({ deps, store, jobId: job.id, accountName, transcript })
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'prep_failed' })
    }
  })

  router.get('/prep/:jobId', (req, res) => {
    const job = store.get(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'unknown_job' })
      return
    }
    const { status, recordId, summary, error, account } = job
    res.json({ status, recordId, summary, error, account })
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && npm test`
Expected: PASS (routes tests + all prior).

- [ ] **Step 5: Add `openaiChat` + `createRecord` + mount the router in `proxy/server.js`**

Add these near the other imports:

```js
import { makePrepRouter } from './routes/prep.js'
```

Add an OpenAI chat helper (reuses `OPENAI_API_KEY`, alongside `transcribePcm`):

```js
// Chat completion used to compose the meeting brief. Throws on any error so
// composeBrief can fall back to its deterministic template.
async function openaiChat({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error('openai_not_configured')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
    }),
  })
  if (!res.ok) throw new Error(`openai chat ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}
```

Add a write-capable Salesforce connection + `createRecord` (works on Heroku via `SFDX_AUTH_URL`, and locally via the `sf` CLI session):

```js
// A jsforce connection with write scope. On Heroku we already build one from
// SFDX_AUTH_URL; locally we borrow the sf CLI session's access token.
let writeConnPromise = null
async function getWriteConnection() {
  if (SFDX_AUTH_URL) return getConnection() // existing helper (auth-url mode)
  if (!writeConnPromise) {
    writeConnPromise = (async () => {
      const { stdout } = await execFileAsync(
        'sf',
        ['org', 'display', '--target-org', SF_TARGET_ORG, '--json'],
        { maxBuffer: 10 * 1024 * 1024 },
      )
      const r = JSON.parse(stdout).result
      return new jsforce.Connection({
        instanceUrl: r.instanceUrl,
        accessToken: r.accessToken,
      })
    })()
  }
  return writeConnPromise
}

async function createRecord(sobject, fields) {
  const conn = await getWriteConnection()
  const result = await conn.sobject(sobject).create(fields)
  if (!result.success) {
    throw new Error(`create ${sobject} failed: ${JSON.stringify(result.errors)}`)
  }
  return { id: result.id }
}
```

Mount the router after `app.use(express.json(...))` and before `app.listen`:

```js
app.use(
  makePrepRouter({
    transcribePcm,
    findAccount,
    runQuery,
    openaiChat,
    createRecord,
  }),
)
```

- [ ] **Step 6: Boot smoke test**

Run: `cd proxy && SF_TARGET_ORG=evenTest node -e "import('./server.js')" & sleep 2 && curl -s localhost:3000/health && echo && curl -s -X POST localhost:3000/prep -H 'Content-Type: application/json' -d '{"text":"prep me for the meeting"}'; kill %1`
Expected: `/health` prints; the `/prep` call returns `{"error":"no_account",...}` (400) — proving the route is mounted. (A real account name requires the org; covered in Task 13.)

- [ ] **Step 7: Commit**

```bash
git add proxy/routes/prep.js proxy/test/routes-prep.test.js proxy/server.js
git commit -m "feat: add /prep async routes and wire OpenAI + Salesforce write"
```

---

### Task 11: Salesforce metadata — `Meeting_Prep__c`

**Files:**
- Create: `salesforce/sfdx-project.json`
- Create: `salesforce/force-app/main/default/objects/Meeting_Prep__c/Meeting_Prep__c.object-meta.xml`
- Create: `salesforce/force-app/main/default/objects/Meeting_Prep__c/fields/Account__c.field-meta.xml`
- Create: `.../fields/Brief__c.field-meta.xml`
- Create: `.../fields/Meeting_Date__c.field-meta.xml`
- Create: `.../fields/Attendees__c.field-meta.xml`
- Create: `.../fields/Status__c.field-meta.xml`
- Create: `.../fields/Source__c.field-meta.xml`
- Create: `.../fields/Transcript__c.field-meta.xml`

**Interfaces:**
- Produces the `Meeting_Prep__c` object + fields consumed by `record.js` (Task 7).

- [ ] **Step 1: Create `salesforce/sfdx-project.json`**

```json
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "61.0"
}
```

- [ ] **Step 2: Create the object** — `Meeting_Prep__c.object-meta.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Meeting Prep</label>
    <pluralLabel>Meeting Preps</pluralLabel>
    <nameField>
        <type>AutoNumber</type>
        <label>Prep Number</label>
        <displayFormat>Prep-{0000}</displayFormat>
    </nameField>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
```

- [ ] **Step 3: Create the fields**

`Account__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <label>Account</label>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
    <relationshipLabel>Meeting Preps</relationshipLabel>
    <relationshipName>Meeting_Preps</relationshipName>
    <required>false</required>
</CustomField>
```

`Brief__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Brief__c</fullName>
    <label>Brief</label>
    <type>LongTextArea</type>
    <length>131072</length>
    <visibleLines>20</visibleLines>
</CustomField>
```

`Meeting_Date__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Meeting_Date__c</fullName>
    <label>Meeting Date</label>
    <type>Date</type>
</CustomField>
```

`Attendees__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Attendees__c</fullName>
    <label>Attendees</label>
    <type>LongTextArea</type>
    <length>32768</length>
    <visibleLines>5</visibleLines>
</CustomField>
```

`Status__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Draft</fullName><default>true</default><label>Draft</label></value>
            <value><fullName>Ready</fullName><default>false</default><label>Ready</label></value>
            <value><fullName>Failed</fullName><default>false</default><label>Failed</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

`Source__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Source__c</fullName>
    <label>Source</label>
    <type>Text</type>
    <length>50</length>
</CustomField>
```

`Transcript__c.field-meta.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Transcript__c</fullName>
    <label>Transcript</label>
    <type>Text</type>
    <length>255</length>
</CustomField>
```

- [ ] **Step 4: Deploy to the authenticated org**

Run: `cd salesforce && sf project deploy start --source-dir force-app --target-org evenTest`
Expected: `Deploy ... Succeeded` listing the `Meeting_Prep__c` object and 7 fields.

- [ ] **Step 5: Verify with a query**

Run: `sf data query --query "SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = 'Meeting_Prep__c'" --target-org evenTest --json`
Expected: one row returned for `Meeting_Prep__c`.

- [ ] **Step 6: Commit**

```bash
git add salesforce
git commit -m "feat: add Meeting_Prep__c custom object metadata"
```

---

### Task 12: Glasses app — "Prep meeting" view

**Files:**
- Modify: `app/src/main.ts`

**Interfaces:**
- Consumes: proxy `POST /prep` and `GET /prep/:jobId` (Task 10).
- Adds a top menu row that captures a spoken prep request and shows job status.

- [ ] **Step 1: Add a prep interface + state**

Near the other interfaces/state in `app/src/main.ts`, add:

```ts
interface PrepStart { jobId: string; account: string; status: string }
interface PrepStatus {
  status: 'running' | 'done' | 'failed'
  recordId?: string
  summary?: string
  error?: string
  account?: string
}

let captureMode: 'search' | 'prep' = 'search'
```

- [ ] **Step 2: Replace `renderAccounts` to include a Prep row at the top**

```ts
const PREP_ROW = 'Prep meeting (voice)'

function renderAccounts(): string {
  const prepRow = `${selected === 0 ? '>' : ' '} ${PREP_ROW}`
  const rows = accounts
    .map((a, i) => `${i + 1 === selected ? '>' : ' '} ${i + 1}. ${a.name}`)
    .join('\n')
  const exitIdx = accounts.length + 1
  const exitRow = `${selected === exitIdx ? '>' : ' '} Exit to glasses menu`
  return `Salesforce\n\n${prepRow}\n${rows}\n${exitRow}\n\nTap: select  Swipe: move`
}
```

- [ ] **Step 3: Update `moveCursor` count and `onSingleTap` account handling**

Replace `moveCursor`:

```ts
async function moveCursor(delta: number) {
  if (view !== 'accounts' || accounts.length === 0) return
  const n = accounts.length + 2 // prep row + accounts + exit row
  selected = (selected + delta + n) % n
  await setText(renderAccounts())
}
```

Replace the `accounts` branch of `onSingleTap`:

```ts
  } else if (view === 'accounts') {
    if (selected === 0) {
      await startListening('prep')
    } else if (selected === accounts.length + 1) {
      await exitApp()
    } else {
      await openSelectedAccount() // uses accounts[selected - 1]
    }
  }
```

And update `openSelectedAccount` to use the shifted index:

```ts
async function openSelectedAccount() {
  const account = accounts[selected - 1]
  if (!account) return
  // ...rest of the existing body unchanged...
}
```

- [ ] **Step 4: Give `startListening` a mode; keep search working**

Change the signature and the double-tap default:

```ts
async function startListening(mode: 'search' | 'prep' = 'search') {
  if (busy || recording) return
  captureMode = mode
  recording = true
  pcmChunks = []
  view = 'listening'
  const hint =
    mode === 'prep'
      ? 'Prep: say e.g. "prep me for the Omega meeting"'
      : 'Say e.g. "show me details about NetAssist"'
  await setText(`Listening...\n\n${hint}\n\nTap: send   x2: cancel`)
  try {
    await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch (err) {
    recording = false
    await setText(`Mic error\n\n${(err as Error).message}\n\nTap: back`)
  }
}
```

In `onSingleTap`, route the `listening` stop by mode:

```ts
  if (view === 'listening') {
    if (captureMode === 'prep') await stopListeningAndPrep()
    else await stopListeningAndSearch()
    return
  }
```

- [ ] **Step 5: Add `stopListeningAndPrep` + `pollPrep`**

```ts
async function stopListeningAndPrep() {
  if (!recording) return
  recording = false
  try { await bridge.audioControl(false) } catch { /* ignore */ }

  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  if (total === 0) {
    view = 'result'
    await setText('No audio captured.\n\nTap: back')
    return
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length }
  pcmChunks = []

  busy = true
  view = 'result'
  try {
    await setText('Preparing brief...')
    const audioBase64 = uint8ToBase64(merged)
    const start = await postJson<PrepStart>('/prep', { audioBase64 })
    await setText(`Preparing brief for ${start.account}...`)
    await pollPrep(start.jobId, start.account)
  } catch (err) {
    await setText(`Prep failed\n\n${(err as Error).message}\n\nTap: back`)
  } finally {
    busy = false
  }
}

async function pollPrep(jobId: string, account: string) {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await fetchJson<PrepStatus>(`/prep/${jobId}`)
    if (s.status === 'done') {
      await setText(`Prep ready for ${account}\n\n${s.summary || 'Saved to Salesforce.'}\n\nTap: back`)
      return
    }
    if (s.status === 'failed') {
      await setText(`Prep failed for ${account}\n\n${s.error || ''}\n\nTap: back`)
      return
    }
  }
  await setText(`Still working on ${account} — check Salesforce.\n\nTap: back`)
}
```

- [ ] **Step 6: Build the app to confirm it compiles**

Run: `cd app && npm run build`
Expected: `tsc` + `vite build` succeed with no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/main.ts
git commit -m "feat: add glasses Prep meeting voice view with status polling"
```

---

### Task 13: End-to-end verification (simulator + org)

**Files:** none (verification only).

- [ ] **Step 1: Run the full proxy test suite**

Run: `cd proxy && npm test`
Expected: all tests pass (text, intent, queries, gather, mock, compose, record, jobs, runner, routes-prep).

- [ ] **Step 2: Start the proxy against the org with OpenAI enabled**

Run: `cd proxy && SF_TARGET_ORG=evenTest OPENAI_API_KEY=sk-... npm start`
Expected: `SF->EvenHub proxy listening on :3000`.

- [ ] **Step 3: Drive a real prep by text (uses a real account name in your org)**

Run:
```bash
JOB=$(curl -s -X POST localhost:3000/prep -H 'Content-Type: application/json' \
  -d '{"text":"prep me for the <RealAccountName> meeting"}' | jq -r .jobId)
sleep 8
curl -s localhost:3000/prep/$JOB | jq
```
Expected: final status `done` with a `recordId` and a `summary`. Replace `<RealAccountName>` with an account that exists in `evenTest`.

- [ ] **Step 4: Confirm the record landed in Salesforce**

Run: `sf data query --query "SELECT Name, Account__r.Name, Status__c, Source__c FROM Meeting_Prep__c ORDER BY CreatedDate DESC LIMIT 1" --target-org evenTest --json`
Expected: one `Ready` record linked to the account, `Source__c = glasses-voice`.

- [ ] **Step 5: Simulator voice run**

Run (three terminals, per README):
```bash
cd proxy && SF_TARGET_ORG=evenTest OPENAI_API_KEY=sk-... npm start
cd app && VITE_PROXY_URL=http://localhost:3000 npm run dev
evenhub-simulator http://localhost:5173 --automation-port 9898
```
Then in the simulator: select the top **"Prep meeting (voice)"** row, tap to start, speak a prep request, tap to send, and confirm the glasses show "Preparing brief… → Prep ready for <Account>".

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: verification fixes for meeting-prep e2e"
```

---

## Self-Review

**1. Spec coverage**
- Glasses-voice trigger → Tasks 10 (POST /prep audio) + 12 (app view). ✓
- Proxy orchestration → Tasks 4–10. ✓
- Real CRM (Account/Opportunity/Case/Contact) → Tasks 3–4. ✓
- Mocked docs/web/calendar → Task 5. ✓
- OpenAI composition + template fallback → Task 6. ✓
- `Meeting_Prep__c` output linked to Account → Tasks 7 + 11. ✓
- Async execution + glasses poll → Tasks 8, 9, 10, 12. ✓
- Error handling (no account, STT/LLM/write failures, poll timeout) → Tasks 6, 9, 10, 12. ✓
- Heroku hosting / existing auth reuse → Task 10 (`getWriteConnection` handles both modes). ✓
- Testing harness (node:test, no deps) → Tasks 1–10. ✓

**2. Placeholder scan** — No "TBD"/"handle edge cases"-style gaps; every code step shows full code. The only intentional operator-supplied values are `sk-...` (OpenAI key) and `<RealAccountName>` in Task 13, which are runtime inputs, not plan placeholders.

**3. Type consistency** — `runQuery`, `findAccount`, `openaiChat`, `createRecord`, and the `store` interface (`create`/`get`/`update`) are used with identical signatures across Tasks 4, 6, 7, 8, 9, and 10. `composeBrief` returns `{ brief, source }` and is consumed that way in the runner. `writeMeetingPrep` returns the id string, consumed as `recordId`. Field API names in `record.js` (Task 7) match the metadata in Task 11.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-19-meeting-prep.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
