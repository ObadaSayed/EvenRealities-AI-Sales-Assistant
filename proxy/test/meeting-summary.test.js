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
