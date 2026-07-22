import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gatherAccountData } from '../lib/prep/gather.js'

function fakeRunQuery(map) {
  return async (soql) => {
    if (/FROM Account/.test(soql)) return map.account
    if (/FROM Opportunity/.test(soql)) return map.opps
    if (/FROM Case/.test(soql)) return map.cases
    if (/FROM Contact/.test(soql)) return map.contacts
    return []
  }
}

test('gatherAccountData aggregates records and metrics', async () => {
  const runQuery = fakeRunQuery({
    account: [{ Id: '001', Name: 'Omega', Industry: 'Tech', LastActivityDate: '2026-07-01' }],
    opps: [
      { Id: 'o1', Name: 'Deal A', Amount: 100, StageName: 'Prospecting', IsClosed: false, IsWon: false },
      { Id: 'o2', Name: 'Deal B', Amount: 50, StageName: 'Closed Won', IsClosed: true, IsWon: true },
    ],
    cases: [
      { Id: 'c1', CaseNumber: '0001', Subject: 'Late delivery', Status: 'New', IsClosed: false },
    ],
    contacts: [{ Id: 'p1', Name: 'Jane Doe', Title: 'VP Ops' }],
  })

  const data = await gatherAccountData({ runQuery, accountId: '001' })
  assert.equal(data.account.name, 'Omega')
  assert.equal(data.account.lastActivityDate, '2026-07-01')
  assert.equal(data.opportunities.length, 2)
  assert.equal(data.metrics.totalPipeline, 150)
  assert.equal(data.metrics.openPipeline, 100)
  assert.equal(data.metrics.openCaseCount, 1)
  assert.equal(data.contacts[0].name, 'Jane Doe')
})
