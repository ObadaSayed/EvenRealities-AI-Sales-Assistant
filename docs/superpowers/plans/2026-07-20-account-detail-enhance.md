# Rich Account Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the on-glasses account detail view into a prep-oriented view with a text bar chart (open pipeline by stage), Main Contacts, Last Interaction, and async LLM-generated Key Talking Points.

**Architecture:** Reuse the proxy's `gatherAccountData` to fetch Account/Opps/Cases/Contacts in one call. Add pure aggregation (`lib/detail/aggregate.js`) and talking-points (`lib/detail/talkingPoints.js`) modules, expose two GET routes (`/accounts/:id/detail` fast, `/accounts/:id/talking-points` LLM). The app renders the fast detail immediately and streams talking points in on arrival.

**Tech Stack:** Node ≥20 ESM, Express, jsforce, OpenAI (existing `openaiChat`), `node:test`; app is TypeScript + Vite.

## Global Constraints

- Node ≥20, ESM only. No new npm dependencies (tests use `node:test` + `node:assert`).
- Proxy code lives in the nested `proxy/` git repo; app + docs live in the root repo. Commit with inline identity: `git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "..."`. Stage only each task's files (no `git add -A`).
- Never dead-end: talking points fall back to rule-based text on OpenAI error/empty.
- Detail view renders fast; the LLM call must not block the initial render.
- Bars use a single repeated glyph (`█`) — safe on the proportional display font.

---

### Task 1: Add LastActivityDate to account query + gather

**Files:**
- Modify: `proxy/lib/prep/queries.js` (accountByIdSoql)
- Modify: `proxy/lib/prep/gather.js` (account normalization)
- Test: `proxy/test/queries.test.js`, `proxy/test/gather.test.js` (update existing)

**Interfaces:**
- Produces: `accountByIdSoql(id)` now selects `LastActivityDate`; `gatherAccountData(...)` returns `account.lastActivityDate: string | null`.

- [ ] **Step 1: Update the failing tests**

In `proxy/test/queries.test.js`, update the `accountByIdSoql` assertion to require the new field:
```js
assert.match(accountByIdSoql('001'), /LastActivityDate/)
```
In `proxy/test/gather.test.js`, in the account record returned by the fake `runQuery` (the `/FROM Account/` branch) add `LastActivityDate: '2026-07-01'`, and after calling `gatherAccountData`, assert:
```js
assert.equal(result.account.lastActivityDate, '2026-07-01')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd proxy && npm test`
Expected: the two updated assertions FAIL (field missing).

- [ ] **Step 3: Implement**

In `proxy/lib/prep/queries.js`, change `accountByIdSoql` to include `LastActivityDate`:
```js
export function accountByIdSoql(id) {
  return (
    `SELECT Id, Name, Industry, Type, Website, Phone, AnnualRevenue, ` +
    `BillingCity, BillingState, Description, LastActivityDate ` +
    `FROM Account WHERE Id = '${id}' LIMIT 1`
  )
}
```
In `proxy/lib/prep/gather.js`, add to the `account` object (after `description`):
```js
    description: a.Description ?? null,
    lastActivityDate: a.LastActivityDate ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd proxy && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/prep/queries.js lib/prep/gather.js test/queries.test.js test/gather.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: include LastActivityDate in account query + gather"
```

---

### Task 2: Detail aggregation module

**Files:**
- Create: `proxy/lib/detail/aggregate.js`
- Test: `proxy/test/detail-aggregate.test.js`

**Interfaces:**
- Consumes: bundle from `gatherAccountData` → `{ account, opportunities, cases, contacts, metrics }`, where each opp is `{ name, amount, stage, isClosed, isWon, closeDate }`, each case `{ status, isClosed, createdDate }`, each contact `{ name, title }`, and `account.lastActivityDate`.
- Produces:
  - `stageBreakdown(opportunities) -> Array<{ stage: string, amount: number }>` (open opps only, summed per stage, sorted desc).
  - `resolveLastInteraction({ account, cases }) -> { date: string, source: string } | null`.
  - `buildDetail(bundle) -> { account: {id,name}, metrics, stages, contacts: Array<{name,title}>, lastInteraction }`.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/detail-aggregate.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageBreakdown, resolveLastInteraction, buildDetail } from '../lib/detail/aggregate.js'

const opps = [
  { name: 'Big', amount: 5800000, stage: 'Negotiation', isClosed: false, isWon: false, closeDate: '2027-03-01' },
  { name: 'Won1', amount: 2400000, stage: 'Closed Won', isClosed: true, isWon: true, closeDate: '2026-01-01' },
  { name: 'Mid', amount: 1200000, stage: 'Proposal', isClosed: false, isWon: false, closeDate: '2027-02-01' },
  { name: 'Small', amount: 750000, stage: 'Discovery', isClosed: false, isWon: false, closeDate: '2027-04-01' },
]

test('stageBreakdown sums open opps by stage, sorted desc', () => {
  const b = stageBreakdown(opps)
  assert.deepEqual(b, [
    { stage: 'Negotiation', amount: 5800000 },
    { stage: 'Proposal', amount: 1200000 },
    { stage: 'Discovery', amount: 750000 },
  ])
})

test('resolveLastInteraction prefers account activity date', () => {
  const r = resolveLastInteraction({
    account: { lastActivityDate: '2026-07-10' },
    cases: [{ createdDate: '2026-06-01' }],
  })
  assert.equal(r.date, '2026-07-10')
  assert.equal(r.source, 'activity')
})

test('resolveLastInteraction falls back to most recent case', () => {
  const r = resolveLastInteraction({
    account: { lastActivityDate: null },
    cases: [{ createdDate: '2026-06-01' }, { createdDate: '2026-06-20' }],
  })
  assert.equal(r.date, '2026-06-20')
  assert.equal(r.source, 'case')
})

test('resolveLastInteraction returns null when nothing available', () => {
  assert.equal(resolveLastInteraction({ account: {}, cases: [] }), null)
})

test('buildDetail returns view-ready shape with top-4 contacts', () => {
  const contacts = Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, title: `T${i}`, email: 'x' }))
  const d = buildDetail({
    account: { id: '001', name: 'Acme', lastActivityDate: '2026-07-10' },
    opportunities: opps,
    cases: [{ createdDate: '2026-06-01', isClosed: false }],
    contacts,
    metrics: { totalPipeline: 10150000, openPipeline: 7750000, openCaseCount: 1, wonCount: 1 },
  })
  assert.equal(d.account.name, 'Acme')
  assert.equal(d.stages[0].stage, 'Negotiation')
  assert.equal(d.contacts.length, 4)
  assert.deepEqual(d.contacts[0], { name: 'C0', title: 'T0' })
  assert.equal(d.lastInteraction.date, '2026-07-10')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/detail-aggregate.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `proxy/lib/detail/aggregate.js`:
```js
export function stageBreakdown(opportunities) {
  const open = (opportunities || []).filter((o) => !o.isClosed)
  const byStage = new Map()
  for (const o of open) {
    const stage = o.stage || 'Unknown'
    byStage.set(stage, (byStage.get(stage) || 0) + (o.amount || 0))
  }
  return [...byStage.entries()]
    .map(([stage, amount]) => ({ stage, amount }))
    .sort((a, b) => b.amount - a.amount)
}

export function resolveLastInteraction({ account, cases }) {
  const candidates = []
  if (account?.lastActivityDate) {
    candidates.push({ date: account.lastActivityDate, source: 'activity' })
  }
  for (const c of cases || []) {
    if (c.createdDate) candidates.push({ date: c.createdDate, source: 'case' })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return candidates[0]
}

export function buildDetail(bundle) {
  const { account, opportunities, cases, contacts, metrics } = bundle
  return {
    account: { id: account.id, name: account.name },
    metrics,
    stages: stageBreakdown(opportunities),
    contacts: (contacts || []).slice(0, 4).map((c) => ({ name: c.name, title: c.title ?? null })),
    lastInteraction: resolveLastInteraction({ account, cases }),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/detail-aggregate.test.js`
Expected: PASS. Then `cd proxy && npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/detail/aggregate.js test/detail-aggregate.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add account detail aggregation (stages, last interaction)"
```

---

### Task 3: Talking-points module (LLM + rule-based fallback)

**Files:**
- Create: `proxy/lib/detail/talkingPoints.js`
- Test: `proxy/test/talking-points.test.js`

**Interfaces:**
- Consumes: bundle from `gatherAccountData`; injected `openaiChat({ system, user }) -> Promise<string>`.
- Produces:
  - `ruleBasedPoints(bundle) -> string[]` (≤5).
  - `buildPointsPrompt(bundle) -> { system, user }`.
  - `composeTalkingPoints({ bundle, openaiChat }) -> Promise<{ points: string[], source: 'openai' | 'rule' }>`.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/talking-points.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ruleBasedPoints,
  buildPointsPrompt,
  composeTalkingPoints,
} from '../lib/detail/talkingPoints.js'

const bundle = {
  account: { name: 'Acme' },
  opportunities: [
    { name: 'Big', amount: 5800000, stage: 'Negotiation', isClosed: false, isWon: false },
    { name: 'Won1', amount: 2400000, stage: 'Closed Won', isClosed: true, isWon: true },
  ],
  cases: [
    { subject: 'Outage', status: 'New', isClosed: false },
    { subject: 'Bug', status: 'Closed', isClosed: true },
  ],
  metrics: { totalPipeline: 8200000, openPipeline: 5800000, openCaseCount: 1, wonCount: 1 },
}

test('ruleBasedPoints leads with biggest open deal and includes case warning + won reference', () => {
  const p = ruleBasedPoints(bundle)
  assert.ok(p.length >= 1 && p.length <= 5)
  assert.match(p[0], /Big/)
  assert.ok(p.some((x) => /open case/i.test(x)))
  assert.ok(p.some((x) => /Won1/.test(x)))
})

test('buildPointsPrompt includes account name and opportunities', () => {
  const { system, user } = buildPointsPrompt(bundle)
  assert.match(system, /talking points/i)
  assert.match(user, /Acme/)
  assert.match(user, /Big/)
})

test('composeTalkingPoints parses OpenAI bullets on success', async () => {
  const openaiChat = async () => '- Push the Negotiation deal\n- Check the open outage\n2. Thank them for Won1'
  const r = await composeTalkingPoints({ bundle, openaiChat })
  assert.equal(r.source, 'openai')
  assert.deepEqual(r.points, ['Push the Negotiation deal', 'Check the open outage', 'Thank them for Won1'])
})

test('composeTalkingPoints falls back to rule-based on throw', async () => {
  const openaiChat = async () => { throw new Error('no key') }
  const r = await composeTalkingPoints({ bundle, openaiChat })
  assert.equal(r.source, 'rule')
  assert.ok(r.points.length >= 1)
})

test('composeTalkingPoints falls back on empty completion', async () => {
  const openaiChat = async () => '   '
  const r = await composeTalkingPoints({ bundle, openaiChat })
  assert.equal(r.source, 'rule')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/talking-points.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `proxy/lib/detail/talkingPoints.js`:
```js
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

export function ruleBasedPoints(bundle) {
  const { opportunities = [], cases = [] } = bundle
  const points = []
  const openOpps = opportunities.filter((o) => !o.isClosed)
  if (openOpps.length) {
    const top = [...openOpps].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0]
    points.push(`Advance ${top.name} (${money(top.amount)}) — currently ${top.stage}.`)
  }
  const openCases = cases.filter((c) => !c.isClosed)
  if (openCases.length) {
    points.push(`${openCases.length} open case(s) — check delivery/support health before the meeting.`)
  }
  const won = opportunities.find((o) => o.isWon)
  if (won) {
    points.push(`Reference the ${won.name} win to reinforce the relationship.`)
  }
  if (points.length === 0) {
    points.push('No open pipeline or cases — explore new needs and expansion.')
  }
  return points.slice(0, 5)
}

export function buildPointsPrompt(bundle) {
  const { account = {}, opportunities = [], cases = [], metrics = {} } = bundle
  const oppLines = opportunities
    .slice(0, 10)
    .map((o) => `- ${o.name}: ${money(o.amount)} [${o.stage}${o.isClosed ? ', closed' : ', open'}${o.isWon ? ', won' : ''}]`)
    .join('\n')
  const caseLines = cases
    .slice(0, 10)
    .map((c) => `- ${c.subject} [${c.status}]`)
    .join('\n')
  const system =
    'You are a sales assistant. Given CRM data for an account, produce 3-5 short, specific talking points for an upcoming meeting. One point per line, imperative, under 90 characters. Return only the points, one per line, with no numbering or preamble.'
  const user =
    `Account: ${account.name}\n` +
    `Open pipeline: ${money(metrics.openPipeline)} of ${money(metrics.totalPipeline)} total\n` +
    `Open cases: ${metrics.openCaseCount ?? 0}\n\n` +
    `Opportunities:\n${oppLines || '(none)'}\n\n` +
    `Cases:\n${caseLines || '(none)'}`
  return { system, user }
}

function parsePoints(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

export async function composeTalkingPoints({ bundle, openaiChat }) {
  try {
    const { system, user } = buildPointsPrompt(bundle)
    const reply = await openaiChat({ system, user })
    const points = parsePoints(reply)
    if (points.length === 0) throw new Error('empty completion')
    return { points, source: 'openai' }
  } catch {
    return { points: ruleBasedPoints(bundle), source: 'rule' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/talking-points.test.js`
Expected: PASS. Then `cd proxy && npm test` — all pass.

- [ ] **Step 5: Commit**

```bash
cd proxy && git add lib/detail/talkingPoints.js test/talking-points.test.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add account talking points (LLM + rule-based fallback)"
```

---

### Task 4: Detail routes + server wiring

**Files:**
- Create: `proxy/routes/detail.js`
- Create: `proxy/test/routes-detail.test.js`
- Modify: `proxy/server.js` (import + mount)

**Interfaces:**
- Consumes: `gatherAccountData` (`../lib/prep/gather.js`), `buildDetail` (`../lib/detail/aggregate.js`), `composeTalkingPoints` (`../lib/detail/talkingPoints.js`); injected deps `{ runQuery, openaiChat }`.
- Produces: `makeDetailRouter(deps)` mounting `GET /accounts/:id/detail` and `GET /accounts/:id/talking-points`.

- [ ] **Step 1: Write the failing test**

Create `proxy/test/routes-detail.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { makeDetailRouter } from '../routes/detail.js'

function startServer(deps) {
  const app = express()
  app.use(express.json())
  app.use(makeDetailRouter(deps))
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

const fakeRunQuery = async (soql) => {
  if (/FROM Account/.test(soql)) return [{ Id: '001', Name: 'Acme', LastActivityDate: '2026-07-10' }]
  if (/FROM Opportunity/.test(soql)) return [{ Id: 'o1', Name: 'Big', Amount: 100, StageName: 'Negotiation', IsClosed: false, IsWon: false }]
  if (/FROM Case/.test(soql)) return [{ Id: 'c1', CaseNumber: '1', Subject: 'X', Status: 'New', IsClosed: false, CreatedDate: '2026-06-01' }]
  if (/FROM Contact/.test(soql)) return [{ Id: 'p1', Name: 'Jane', Title: 'CEO' }]
  return []
}

test('GET /accounts/:id/detail returns view-ready detail', async () => {
  const { server, port } = await startServer({ runQuery: fakeRunQuery, openaiChat: async () => '' })
  const res = await fetch(`http://localhost:${port}/accounts/001/detail`)
  const body = await res.json()
  server.close()
  assert.equal(res.status, 200)
  assert.equal(body.account.name, 'Acme')
  assert.equal(body.stages[0].stage, 'Negotiation')
  assert.equal(body.contacts[0].name, 'Jane')
  assert.equal(body.lastInteraction.date, '2026-07-10')
})

test('GET /accounts/:id/talking-points returns points via OpenAI', async () => {
  const openaiChat = async () => '- Push Big\n- Handle case'
  const { server, port } = await startServer({ runQuery: fakeRunQuery, openaiChat })
  const res = await fetch(`http://localhost:${port}/accounts/001/talking-points`)
  const body = await res.json()
  server.close()
  assert.equal(res.status, 200)
  assert.equal(body.source, 'openai')
  assert.deepEqual(body.points, ['Push Big', 'Handle case'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && node --test test/routes-detail.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement router**

Create `proxy/routes/detail.js`:
```js
import express from 'express'
import { gatherAccountData } from '../lib/prep/gather.js'
import { buildDetail } from '../lib/detail/aggregate.js'
import { composeTalkingPoints } from '../lib/detail/talkingPoints.js'

export function makeDetailRouter(deps) {
  const { runQuery, openaiChat } = deps
  const router = express.Router()

  router.get('/accounts/:id/detail', async (req, res) => {
    try {
      const bundle = await gatherAccountData({ runQuery, accountId: req.params.id })
      res.json(buildDetail(bundle))
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'detail_failed' })
    }
  })

  router.get('/accounts/:id/talking-points', async (req, res) => {
    try {
      const bundle = await gatherAccountData({ runQuery, accountId: req.params.id })
      res.json(await composeTalkingPoints({ bundle, openaiChat }))
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'talking_points_failed' })
    }
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && node --test test/routes-detail.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into server.js**

In `proxy/server.js`, add the import next to the prep router import (line ~10):
```js
import { makeDetailRouter } from './routes/detail.js'
```
Immediately after the `app.use(makePrepRouter({ ... }))` block (before `app.use(express.static(...))`), add:
```js
app.use(makeDetailRouter({ runQuery, openaiChat }))
```

- [ ] **Step 6: Verify full suite + boot smoke test**

Run: `cd proxy && npm test` (all pass), then:
```bash
cd proxy && node --check server.js && PORT=3998 SF_TARGET_ORG=evenTest node --env-file=.env server.js &
sleep 3 && curl -s localhost:3998/health && kill %1
```
Expected: `node --check` clean; `/health` returns JSON (route mounted, server boots).

- [ ] **Step 7: Commit**

```bash
cd proxy && git add routes/detail.js test/routes-detail.test.js server.js
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: add /accounts/:id/detail and /talking-points routes"
```

---

### Task 5: Glasses app rich detail view

**Files:**
- Modify: `app/src/main.ts`

**Interfaces:**
- Consumes: `GET /accounts/:id/detail` → `DetailResult`; `GET /accounts/:id/talking-points` → `{ points: string[], source: string }`.
- Produces: enhanced `openSelectedAccount`, plus pure helpers `bar`, `daysAgo`, `renderDetail`.

- [ ] **Step 1: Add types and helpers**

In `app/src/main.ts`, replace the `OppsResult` interface and the `renderOpps` function (they are only used by `openSelectedAccount`) with the new detail types and helpers.

Add interfaces (near the other interfaces):
```ts
interface StageSlice { stage: string; amount: number }
interface ContactLite { name: string; title: string | null }
interface LastInteraction { date: string; source: string }
interface DetailResult {
  account: { id: string; name: string }
  metrics: { totalPipeline: number; openPipeline: number; openCaseCount: number; wonCount: number }
  stages: StageSlice[]
  contacts: ContactLite[]
  lastInteraction: LastInteraction | null
}
interface TalkingPoints { points: string[]; source: string }
```

Add helpers (near `renderOpps`, which you are removing):
```ts
function bar(value: number, max: number, width = 10): string {
  if (max <= 0) return ''
  const cells = value > 0 ? Math.max(1, Math.round((value / max) * width)) : 0
  return '█'.repeat(cells)
}

function daysAgo(dateStr: string): string {
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return dateStr
  const days = Math.floor((Date.now() - then) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function renderDetail(d: DetailResult, points?: string[] | 'error'): string {
  const head =
    `${d.account.name}\n` +
    `Pipeline ${money(d.metrics.totalPipeline)} · Open ${money(d.metrics.openPipeline)}\n`
  let chart: string
  if (d.stages.length) {
    const max = Math.max(...d.stages.map((s) => s.amount))
    chart =
      '\nOpen by stage\n' +
      d.stages
        .slice(0, 4)
        .map((s) => ` ${s.stage} ${bar(s.amount, max)} ${money(s.amount)}`)
        .join('\n') +
      '\n'
  } else {
    chart = '\nNo open pipeline\n'
  }
  const contacts = d.contacts.length
    ? '\nMain contacts\n' +
      d.contacts.map((c) => ` ${c.name}${c.title ? ' — ' + c.title : ''}`).join('\n') +
      '\n'
    : '\nNo contacts on file\n'
  const last = d.lastInteraction
    ? `Last interaction  ${daysAgo(d.lastInteraction.date)}\n`
    : 'No recent activity\n'
  let tp = '\nKey talking points  (analyzing…)\n'
  if (points === 'error') {
    tp = '\nKey talking points  (unavailable)\n'
  } else if (points && points.length) {
    tp = '\nKey talking points\n' + points.map((p) => ` • ${p}`).join('\n') + '\n'
  }
  return `${head}${chart}${contacts}${last}${tp}\nTap: back  x2: ask by voice`
}
```

- [ ] **Step 2: Rewrite `openSelectedAccount`**

Replace the existing `openSelectedAccount` with:
```ts
async function openSelectedAccount() {
  const account = accounts[selected - 1]
  if (!account) return
  if (busy) return
  busy = true
  view = 'detail'
  let detail: DetailResult
  try {
    await setText(`${account.name}\n\nLoading...`)
    detail = await fetchJson<DetailResult>(`/accounts/${account.id}/detail`)
    await setText(renderDetail(detail))
    console.log('APP_DETAIL_LOADED', account.name)
  } catch (err) {
    await setText(
      `${account.name}\n\nError loading detail\n\n${(err as Error).message}\n\nTap: back`,
    )
    console.error('APP_DETAIL_ERROR', err)
    busy = false
    return
  }
  // Allow tap-back while talking points are generated.
  busy = false
  try {
    const tp = await fetchJson<TalkingPoints>(`/accounts/${account.id}/talking-points`)
    if (view === 'detail') await setText(renderDetail(detail, tp.points))
    console.log('APP_TP_LOADED', account.name, tp.source)
  } catch (err) {
    if (view === 'detail') await setText(renderDetail(detail, 'error'))
    console.error('APP_TP_ERROR', err)
  }
}
```

- [ ] **Step 3: Build to verify types**

Run: `cd app && npm run build`
Expected: `tsc && vite build` exits 0 with no type errors. Fix any unused-symbol errors by ensuring `OppsResult`/`renderOpps` are fully removed and no other references remain.

- [ ] **Step 4: Commit**

```bash
cd /Users/osayed/EvenRealities && git add app/src/main.ts
git -c user.name="osayed" -c user.email="osayed@users.noreply.local" commit -m "feat: rich account detail view (bar chart, contacts, talking points)"
```

---

## Self-Review

**Spec coverage:**
- Text bar chart (open by stage) → Task 2 (`stageBreakdown`) + Task 5 (`bar`/`renderDetail`). ✓
- Main Contacts → Task 2 (`buildDetail` top-4) + Task 5. ✓
- Last Interaction → Task 1 (`LastActivityDate`) + Task 2 (`resolveLastInteraction`) + Task 5 (`daysAgo`). ✓
- Key Talking Points (async LLM + fallback) → Task 3 + Task 4 route + Task 5 async render. ✓
- Fast initial render, non-blocking LLM → Task 5 (`busy=false` before talking-points fetch, `view==='detail'` guard). ✓
- Never dead-end → Task 3 fallback; Task 5 'error' state. ✓
- No new deps, ESM, node:test → all proxy tasks. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `DetailResult`/`TalkingPoints` (Task 5) match the route outputs (`buildDetail` in Task 2, `composeTalkingPoints` in Task 3). `account.lastActivityDate` (Task 1) is consumed by `resolveLastInteraction` (Task 2). `runQuery`/`openaiChat` injected names match `server.js`.
