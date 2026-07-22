import { randomUUID } from 'node:crypto'

export function createMeetingStore() {
  const sessions = new Map()

  function require(id) {
    const s = sessions.get(id)
    if (!s) throw new Error('unknown_session')
    return s
  }

  return {
    start({ accountId, prepId = null, cues = [], prepPoints = [] }) {
      const id = randomUUID()
      sessions.set(id, {
        id,
        accountId,
        prepId,
        prepPoints,
        transcript: '',
        cues,
        startedAt: Date.now(),
        status: 'active',
      })
      return { id }
    },
    get(id) {
      return sessions.get(id)
    },
    appendTranscript(id, text) {
      const s = require(id)
      const add = String(text || '').trim()
      s.transcript = s.transcript ? (add ? `${s.transcript} ${add}` : s.transcript) : add
      return s
    },
    setCues(id, cues) {
      const s = require(id)
      s.cues = cues
      return s
    },
    end(id) {
      const s = require(id)
      s.status = 'ended'
      return s
    },
  }
}
