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
