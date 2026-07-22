const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

export function ruleBasedPoints(bundle) {
  const { opportunities = [], cases = [] } = bundle
  const points = []
  const openOpps = opportunities.filter((o) => !o.isClosed)
  if (openOpps.length) {
    const top = [...openOpps].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0]
    points.push(`Advance ${top.name} (${money(top.amount)}) — currently ${top.stage}.`)
  }
  const openCases = cases.filter((c) => !c.isClosed)
  if (openCases.length) {
    points.push(`${openCases.length} open case(s) — check delivery/support health before the meeting.`)
  }
  const won = opportunities.find((o) => o.isWon)
  if (won) {
    points.push(`Reference the ${won.name} win to reinforce the relationship.`)
  }
  if (points.length === 0) {
    points.push('No open pipeline or cases — explore new needs and expansion.')
  }
  return points.slice(0, 5)
}

export function buildPointsPrompt(bundle) {
  const { account = {}, opportunities = [], cases = [], metrics = {} } = bundle
  const oppLines = opportunities
    .slice(0, 10)
    .map((o) => `- ${o.name}: ${money(o.amount)} [${o.stage}${o.isClosed ? ', closed' : ', open'}${o.isWon ? ', won' : ''}]`)
    .join('\n')
  const caseLines = cases
    .slice(0, 10)
    .map((c) => `- ${c.subject} [${c.status}]`)
    .join('\n')
  const system =
    'You are a sales assistant. Given CRM data for an account, produce 3-5 short, specific talking points for an upcoming meeting. One point per line, imperative, under 90 characters. Return only the points, one per line, with no numbering or preamble.'
  const user =
    `Account: ${account.name}\n` +
    `Open pipeline: ${money(metrics.openPipeline)} of ${money(metrics.totalPipeline)} total\n` +
    `Open cases: ${metrics.openCaseCount ?? 0}\n\n` +
    `Opportunities:\n${oppLines || '(none)'}\n\n` +
    `Cases:\n${caseLines || '(none)'}`
  return { system, user }
}

function parsePoints(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

export async function composeTalkingPoints({ bundle, openaiChat }) {
  try {
    const { system, user } = buildPointsPrompt(bundle)
    const reply = await openaiChat({ system, user })
    const points = parsePoints(reply)
    if (points.length === 0) throw new Error('empty completion')
    return { points, source: 'openai' }
  } catch {
    return { points: ruleBasedPoints(bundle), source: 'rule' }
  }
}
