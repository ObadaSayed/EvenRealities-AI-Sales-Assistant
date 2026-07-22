import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrepIntent } from '../lib/prep/intent.js'

test('detects prep intent and extracts account', () => {
  assert.deepEqual(parsePrepIntent('prep me for the Omega meeting'), {
    isPrep: true,
    accountName: 'Omega',
  })
  assert.deepEqual(parsePrepIntent('prepare a brief for NetAssist'), {
    isPrep: true,
    accountName: 'NetAssist',
  })
})

test('non-prep phrasing returns isPrep false', () => {
  assert.equal(parsePrepIntent('show me details about Acme').isPrep, false)
})

test('prep with no account yields null accountName', () => {
  assert.deepEqual(parsePrepIntent('prep me for the meeting'), {
    isPrep: true,
    accountName: null,
  })
})
