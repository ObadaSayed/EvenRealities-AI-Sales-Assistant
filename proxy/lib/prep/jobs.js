import { randomUUID } from 'node:crypto'

export function createJobStore() {
  const jobs = new Map()
  return {
    create({ account, transcript }) {
      const id = randomUUID()
      const job = { id, status: 'running', account, transcript, createdAt: Date.now() }
      jobs.set(id, job)
      return job
    },
    get(id) {
      return jobs.get(id)
    },
    update(id, patch) {
      const existing = jobs.get(id)
      if (!existing) throw new Error(`unknown job ${id}`)
      const merged = { ...existing, ...patch }
      jobs.set(id, merged)
      return merged
    },
  }
}
