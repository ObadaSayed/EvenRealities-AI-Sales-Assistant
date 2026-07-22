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
