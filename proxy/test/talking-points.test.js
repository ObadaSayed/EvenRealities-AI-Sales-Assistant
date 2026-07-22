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
