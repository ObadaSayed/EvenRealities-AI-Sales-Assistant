import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockRfps, mockAttendeeResearch, mockCalendar } from '../lib/prep/mock.js'

test('mockRfps returns a non-empty deterministic list', () => {
  const a = mockRfps({ name: 'Omega' })
  const b = mockRfps({ name: 'Omega' })
  assert.ok(a.length >= 1)
  assert.deepEqual(a, b)
  assert.ok(a[0].title.includes('Omega'))
})

test('mockAttendeeResearch produces one illustrative entry per contact', () => {
  const res = mockAttendeeResearch([{ name: 'Jane Doe', title: 'VP Ops' }])
  assert.equal(res.length, 1)
  assert.equal(res[0].name, 'Jane Doe')
  assert.match(res[0].summary, /illustrative/i)
  assert.ok(Array.isArray(res[0].career))
})

test('mockCalendar returns a subject referencing the account', () => {
  const cal = mockCalendar({ name: 'Omega' })
  assert.match(cal.subject, /Omega/)
  assert.ok(cal.date)
})
