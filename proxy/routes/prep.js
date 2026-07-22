import express from 'express'
import { parsePrepIntent } from '../lib/prep/intent.js'
import { createJobStore } from '../lib/prep/jobs.js'
import { runPrepJob } from '../lib/prep/runner.js'

export function makePrepRouter(deps) {
  const router = express.Router()
  const store = createJobStore()

  router.post('/prep', async (req, res) => {
    try {
      let transcript = req.body?.text
      if (!transcript && req.body?.audioBase64) {
        transcript = await deps.transcribePcm(req.body.audioBase64)
      }
      if (!transcript) {
        res.status(400).json({ error: 'missing_input' })
        return
      }
      const { accountName } = parsePrepIntent(transcript)
      if (!accountName) {
        res.status(400).json({ error: 'no_account', transcript })
        return
      }
      const job = store.create({ account: accountName, transcript })
      res.json({ jobId: job.id, account: accountName, status: 'started' })

      // Fire-and-forget; runPrepJob catches its own errors into the job.
      void runPrepJob({ deps, store, jobId: job.id, accountName, transcript })
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'prep_failed' })
    }
  })

  router.get('/prep/:jobId', (req, res) => {
    const job = store.get(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'unknown_job' })
      return
    }
    const { status, recordId, summary, error, account } = job
    res.json({ status, recordId, summary, error, account })
  })

  return router
}
