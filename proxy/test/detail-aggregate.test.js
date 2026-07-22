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

test('resolveLastInteraction prefers activity date even when a case is newer', () => {
  const r = resolveLastInteraction({
    account: { lastActivityDate: '2026-01-01' },
    cases: [{ createdDate: '2026-12-01' }],
  })
  assert.equal(r.date, '2026-01-01')
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
