import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { makePrepRouter } from '../routes/prep.js'

function startServer(deps) {
  const app = express()
  app.use(express.json())
  app.use(makePrepRouter(deps))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const baseDeps = {
  transcribePcm: async () => 'prep me for the Omega meeting',
  findAccount: async (name) => ({ Id: '001', Name: name }),
  runQuery: async (soql) => (/FROM Account/.test(soql) ? [{ Id: '001', Name: 'Omega' }] : []),
  openaiChat: async () => 'LLM BRIEF',
  createRecord: async () => ({ id: 'a01ZZZ' }),
}

test('POST /prep with text returns a jobId, GET reaches done', async () => {
  const { server, base } = await startServer(baseDeps)
  try {
    const res = await fetch(`${base}/prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'prep me for the Omega meeting' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.jobId)
    assert.equal(body.account, 'Omega')

    let job
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/prep/${body.jobId}`)
      job = await r.json()
      if (job.status !== 'running') break
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(job.status, 'done')
    assert.equal(job.recordId, 'a01ZZZ')
  } finally {
    server.close()
  }
})

test('POST /prep without an account returns 400', async () => {
  const { server, base } = await startServer({
    ...baseDeps,
    transcribePcm: async () => 'prep me for the meeting',
  })
  try {
    const res = await fetch(`${base}/prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'prep me for the meeting' }),
    })
    assert.equal(res.status, 400)
  } finally {
    server.close()
  }
})

test('GET /prep/:id unknown returns 404', async () => {
  const { server, base } = await startServer(baseDeps)
  try {
    const res = await fetch(`${base}/prep/does-not-exist`)
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})
