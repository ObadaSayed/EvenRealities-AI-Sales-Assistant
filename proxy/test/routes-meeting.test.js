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
