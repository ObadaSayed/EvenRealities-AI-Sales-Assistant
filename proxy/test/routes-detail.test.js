import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { makeDetailRouter } from '../routes/detail.js'

function startServer(deps) {
  const app = express()
  app.use(express.json())
  app.use(makeDetailRouter(deps))
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

const fakeRunQuery = async (soql) => {
  if (/FROM Account/.test(soql)) return [{ Id: '001', Name: 'Acme', LastActivityDate: '2026-07-10' }]
  if (/FROM Opportunity/.test(soql)) return [{ Id: 'o1', Name: 'Big', Amount: 100, StageName: 'Negotiation', IsClosed: false, IsWon: false }]
  if (/FROM Case/.test(soql)) return [{ Id: 'c1', CaseNumber: '1', Subject: 'X', Status: 'New', IsClosed: false, CreatedDate: '2026-06-01' }]
  if (/FROM Contact/.test(soql)) return [{ Id: 'p1', Name: 'Jane', Title: 'CEO' }]
  return []
}

test('GET /accounts/:id/detail returns view-ready detail', async () => {
  const { server, port } = await startServer({ runQuery: fakeRunQuery, openaiChat: async () => '' })
  const res = await fetch(`http://localhost:${port}/accounts/001/detail`)
  const body = await res.json()
  server.close()
  assert.equal(res.status, 200)
  assert.equal(body.account.name, 'Acme')
  assert.equal(body.stages[0].stage, 'Negotiation')
  assert.equal(body.contacts[0].name, 'Jane')
  assert.equal(body.lastInteraction.date, '2026-07-10')
})

test('GET /accounts/:id/talking-points returns points via OpenAI', async () => {
  const openaiChat = async () => '- Push Big\n- Handle case'
  const { server, port } = await startServer({ runQuery: fakeRunQuery, openaiChat })
  const res = await fetch(`http://localhost:${port}/accounts/001/talking-points`)
  const body = await res.json()
  server.close()
  assert.equal(res.status, 200)
  assert.equal(body.source, 'openai')
  assert.deepEqual(body.points, ['Push Big', 'Handle case'])
})
