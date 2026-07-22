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
