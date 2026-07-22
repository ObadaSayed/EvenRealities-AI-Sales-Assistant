import express from 'express'
import { gatherAccountData } from '../lib/prep/gather.js'
import { buildDetail } from '../lib/detail/aggregate.js'
import { composeTalkingPoints } from '../lib/detail/talkingPoints.js'

export function makeDetailRouter(deps) {
  const { runQuery, openaiChat } = deps
  const router = express.Router()

  router.get('/accounts/:id/detail', async (req, res) => {
    try {
      const bundle = await gatherAccountData({ runQuery, accountId: req.params.id })
      res.json(buildDetail(bundle))
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'detail_failed' })
    }
  })

  router.get('/accounts/:id/talking-points', async (req, res) => {
    try {
      const bundle = await gatherAccountData({ runQuery, accountId: req.params.id })
      res.json(await composeTalkingPoints({ bundle, openaiChat }))
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message || 'talking_points_failed' })
    }
  })

  return router
}
