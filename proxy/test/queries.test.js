import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountByIdSoql,
  opportunitiesSoql,
  casesSoql,
  contactsSoql,
} from '../lib/prep/queries.js'

test('accountByIdSoql selects core fields for the id', () => {
  const q = accountByIdSoql('001AAA')
  assert.match(q, /FROM Account/)
  assert.match(q, /WHERE Id = '001AAA'/)
  assert.match(accountByIdSoql('001'), /LastActivityDate/)
})

test('opportunitiesSoql filters by AccountId', () => {
  assert.match(opportunitiesSoql('001AAA'), /WHERE AccountId = '001AAA'/)
})

test('casesSoql filters by AccountId and selects status', () => {
  const q = casesSoql('001AAA')
  assert.match(q, /FROM Case/)
  assert.match(q, /Status/)
})

test('contactsSoql filters by AccountId', () => {
  assert.match(contactsSoql('001AAA'), /FROM Contact/)
})
