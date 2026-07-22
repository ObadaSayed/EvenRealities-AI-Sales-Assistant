import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPrepJob } from '../lib/prep/runner.js'
import { createJobStore } from '../lib/prep/jobs.js'

function makeDeps() {
  return {
    findAccount: async (name) => ({ Id: '001', Name: name }),
    runQuery: async (soql) => {
      if (/FROM Account/.test(soql)) return [{ Id: '001', Name: 'Omega', Industry: 'Tech' }]
      if (/FROM Opportunity/.test(soql)) return [{ Id: 'o1', Name: 'Deal A', Amount: 100, StageName: 'Prospecting', IsClosed: false, IsWon: false }]
      if (/FROM Case/.test(soql)) return [{ Id: 'c1', CaseNumber: '0001', Subject: 'Late', Status: 'New', IsClosed: false }]
      if (/FROM Contact/.test(soql)) return [{ Id: 'p1', Name: 'Jane Doe', Title: 'VP Ops' }]
      return []
    },
    openaiChat: async () => 'LLM BRIEF',
    createRecord: async () => ({ id: 'a01ZZZ' }),
  }
}

test('runPrepJob completes and marks job done', async () => {
  const store = createJobStore()
  const job = store.create({ account: 'Omega', transcript: 't' })
  await runPrepJob({ deps: makeDeps(), store, jobId: job.id, accountName: 'Omega', transcript: 't' })
  const done = store.get(job.id)
  assert.equal(done.status, 'done')
  assert.equal(done.recordId, 'a01ZZZ')
  assert.match(done.summary, /Omega/)
})

test('runPrepJob marks failed when no account matches', async () => {
  const store = createJobStore()
  const deps = makeDeps()
  deps.findAccount = async () => null
  const job = store.create({ account: 'Nope', transcript: 't' })
  await runPrepJob({ deps, store, jobId: job.id, accountName: 'Nope', transcript: 't' })
  assert.equal(store.get(job.id).status, 'failed')
})
