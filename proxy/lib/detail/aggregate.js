export function stageBreakdown(opportunities) {
  const open = (opportunities || []).filter((o) => !o.isClosed)
  const byStage = new Map()
  for (const o of open) {
    const stage = o.stage || 'Unknown'
    byStage.set(stage, (byStage.get(stage) || 0) + (o.amount || 0))
  }
  return [...byStage.entries()]
    .map(([stage, amount]) => ({ stage, amount }))
    .sort((a, b) => b.amount - a.amount)
}

export function resolveLastInteraction({ account, cases }) {
  // Account.LastActivityDate is Salesforce's rollup of the latest task/event,
  // so it is the canonical "last interaction" and always wins when present.
  if (account?.lastActivityDate) {
    return { date: account.lastActivityDate, source: 'activity' }
  }
  // Otherwise fall back to the most recent case creation date.
  const caseDates = (cases || [])
    .filter((c) => c.createdDate)
    .map((c) => ({ date: c.createdDate, source: 'case' }))
  if (caseDates.length === 0) return null
  caseDates.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  return caseDates[0]
}

export function buildDetail(bundle) {
  const { account, opportunities, cases, contacts, metrics } = bundle
  return {
    account: { id: account.id, name: account.name },
    metrics,
    stages: stageBreakdown(opportunities),
    contacts: (contacts || []).slice(0, 4).map((c) => ({ name: c.name, title: c.title ?? null })),
    lastInteraction: resolveLastInteraction({ account, cases }),
  }
}
