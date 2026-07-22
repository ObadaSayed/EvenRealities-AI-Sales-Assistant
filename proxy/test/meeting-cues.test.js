import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackCues, buildCuesPrompt, composeCues } from '../lib/meeting/cues.js'

const prepPoints = ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win', 'Extra point']

test('fallbackCues returns up to 3 prep points', () => {
  assert.deepEqual(fallbackCues({ prepPoints }), ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win'])
})

test('buildCuesPrompt includes transcript and prep points', () => {
  const { system, user } = buildCuesPrompt({ prepPoints, transcript: 'customer mentioned budget', delta: undefined })
  assert.match(system, /cue/i)
  assert.match(user, /budget/)
  assert.match(user, /Phase 2/)
})

test('buildCuesPrompt includes delta in prompt when >= 5 chars', () => {
  const { user } = buildCuesPrompt({
    prepPoints,
    transcript: 'background text',
    delta: 'we have a tight deadline next quarter',
  })
  assert.match(user, /They just said/)
  assert.match(user, /tight deadline/)
})

test('buildCuesPrompt omits delta block when delta is empty', () => {
  const { user } = buildCuesPrompt({ prepPoints, transcript: 'x', delta: '' })
  assert.doesNotMatch(user, /They just said/)
})

test('buildCuesPrompt omits delta block when delta is under 5 chars', () => {
  const { user } = buildCuesPrompt({ prepPoints, transcript: 'x', delta: 'hmm' })
  assert.doesNotMatch(user, /They just said/)
})

test('composeCues parses up to 3 bullets from OpenAI', async () => {
  const openaiChat = async () => '- Ask about budget owner\n- Address latency\n- Offer pilot\n- Too many'
  const r = await composeCues({ prepPoints, transcript: 't', delta: 't', openaiChat })
  assert.equal(r.source, 'openai')
  assert.deepEqual(r.cues, ['Ask about budget owner', 'Address latency', 'Offer pilot'])
})

test('composeCues falls back to prep points on throw', async () => {
  const openaiChat = async () => { throw new Error('no key') }
  const r = await composeCues({ prepPoints, transcript: 't', delta: 't', openaiChat })
  assert.equal(r.source, 'prep')
  assert.deepEqual(r.cues, ['Push Phase 2', 'Check API latency case', 'Cite Phase 1 win'])
})

test('composeCues falls back on empty completion', async () => {
  const openaiChat = async () => '   '
  const r = await composeCues({ prepPoints, transcript: 't', delta: 't', openaiChat })
  assert.equal(r.source, 'prep')
})

test('composeCues passes delta through to prompt', async () => {
  let capturedUser = ''
  const openaiChat = async ({ user }) => { capturedUser = user; return '- Check timeline\n' }
  await composeCues({ prepPoints, transcript: 'background', delta: 'we need delivery by Q3', openaiChat })
  assert.match(capturedUser, /They just said/)
  assert.match(capturedUser, /delivery by Q3/)
})
