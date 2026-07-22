import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobStore } from '../lib/prep/jobs.js'

test('create/get/update lifecycle', () => {
  const store = createJobStore()
  const job = store.create({ account: 'Omega', transcript: 't' })
  assert.equal(job.status, 'running')
  assert.ok(job.id)
  assert.equal(store.get(job.id).account, 'Omega')
  const updated = store.update(job.id, { status: 'done', recordId: 'a01' })
  assert.equal(updated.status, 'done')
  assert.equal(store.get(job.id).recordId, 'a01')
})
