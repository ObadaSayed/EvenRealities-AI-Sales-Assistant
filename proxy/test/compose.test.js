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
