import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractAccountName, normalizeName } from '../lib/text.js'

test('extractAccountName pulls name after a connector word', () => {
  assert.equal(extractAccountName('prep me for the Omega meeting'), 'Omega')
  assert.equal(extractAccountName('show me details about NetAssist'), 'NetAssist')
})

test('extractAccountName strips leading command phrases', () => {
  assert.equal(extractAccountName('open Acme'), 'Acme')
})

test('normalizeName lowercases and strips non-alphanumerics', () => {
  assert.equal(normalizeName('Net Assist, Inc.'), 'netassistinc')
})
