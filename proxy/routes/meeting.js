import express from 'express'
import { composeCues } from '../lib/meeting/cues.js'
import { composeMeetingSummary } from '../lib/meeting/summary.js'
import { buildMeetingNoteRecord, writeMeetingNote } from '../lib/meeting/record.js'

export function makeMeetingRouter(deps) {
  const { transcribePcm, openaiChat, createRecord, store, loadPrepContext } = deps
  const router = express.Router()

  router.post('/meeting/start', async (req, res) => {
    try {
      const accountId = req.body?.accountId
      if (!accountId) return res.status(400).json({ error: 'missing_account' })
      const { prepId, prepPoints } = await loadPrepContext(accountId)
      const { id } = store.start({
        accountId,
        prepId,
        prepPoints: prepPoints || [],
        cues: (prepPoints || []).slice(0, 3),
      })
      res.json({ sessionId: id, cues: store.get(id).cues })
    } catch (err) {
      res.status(502).json({ error: err.message || 'start_failed' })
    }
  })

  router.post('/meeting/:id/chunk', async (req, res) => {
    const id = req.params.id
    if (!store.get(id)) return res.status(404).json({ error: 'unknown_session' })
    try {
      let delta = ''
      try {
        delta = await transcribePcm(req.body?.audioBase64)
      } catch (err) {
        // A dropped chunk must not end the meeting: keep existing cues.
        return res.json({ transcript: '', cues: store.get(id).cues })
      }
      // Skip LLM entirely for silence/noise chunks
      if (!delta || delta.trim().length < 5) {
        return res.json({ transcript: '', cues: store.get(id).cues })
      }
      const session = store.appendTranscript(id, delta)
      const prepPoints = session.prepPoints || []
      const { cues } = await composeCues({ prepPoints, transcript: session.transcript, delta, openaiChat })
      store.setCues(id, cues)
      res.json({ transcript: delta, cues })
    } catch (err) {
      res.status(502).json({ error: err.message || 'chunk_failed' })
    }
  })

  router.post('/meeting/:id/end', async (req, res) => {
    const id = req.params.id
    const session = store.get(id)
    if (!session) return res.status(404).json({ error: 'unknown_session' })
    const { summary, actionItems, nextSteps } = await composeMeetingSummary({
      accountName: session.accountId,
      transcript: session.transcript,
      openaiChat,
    })
    let recordId = null
    let saved = false
    try {
      const record = buildMeetingNoteRecord({
        accountId: session.accountId,
        prepId: session.prepId,
        transcript: session.transcript,
        summary,
        actionItems,
        nextSteps,
        startedAt: session.startedAt,
      })
      const out = await writeMeetingNote({ createRecord, record })
      recordId = out.id
      saved = true
    } catch (err) {
      saved = false
    }
    store.end(id)
    res.json({ summary, actionItems, nextSteps, recordId, saved })
  })

  return router
}
