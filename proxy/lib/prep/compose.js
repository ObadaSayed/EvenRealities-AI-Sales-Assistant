const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US')

export function buildPrompt(bundle) {
  const system =
    'You are a sales enablement assistant. Write a concise, well-structured ' +
    'pre-meeting brief for a salesperson. Use clear section headings and short ' +
    'bullet points. Be factual about CRM data; clearly mark any research as ' +
    'illustrative. Keep it under 400 words.'
  const user = [
    `ACCOUNT: ${bundle.account.name} (${bundle.account.industry || 'n/a'})`,
    `METRICS: total pipeline ${money(bundle.metrics.totalPipeline)}, open ${money(bundle.metrics.openPipeline)}, open cases ${bundle.metrics.openCaseCount}, won ${bundle.metrics.wonCount}`,
    `OPPORTUNITIES: ${JSON.stringify(bundle.opportunities)}`,
    `CASES (complaints): ${JSON.stringify(bundle.cases)}`,
    `RFPS/DOCS (mock): ${JSON.stringify(bundle.rfps)}`,
    `ATTENDEES + RESEARCH (mock): ${JSON.stringify(bundle.research)}`,
    `CALENDAR (mock): ${JSON.stringify(bundle.calendar)}`,
  ].join('\n\n')
  return { system, user }
}

export function renderTemplateBrief(bundle) {
  const { account, metrics, opportunities, cases, rfps, research, calendar } = bundle
  const lines = []
  lines.push(`Meeting Brief — ${account.name}`)
  if (account.industry) lines.push(`Industry: ${account.industry}`)
  lines.push('')
  lines.push(`Upcoming: ${calendar.subject} (${calendar.date}, ${calendar.location})`)
  lines.push('')
  lines.push(`Pipeline: ${money(metrics.totalPipeline)} total, ${money(metrics.openPipeline)} open, ${metrics.wonCount} won`)
  opportunities.slice(0, 6).forEach((o) => lines.push(`  - ${o.name}: ${money(o.amount)} (${o.stage})`))
  lines.push('')
  lines.push(`Complaints / Cases: ${metrics.openCaseCount} open`)
  cases.slice(0, 5).forEach((c) => lines.push(`  - #${c.number} ${c.subject} [${c.status}]`))
  lines.push('')
  lines.push('Recent RFPs / Documents (illustrative):')
  rfps.forEach((r) => lines.push(`  - ${r.title} (${r.status}, ${r.date})`))
  lines.push('')
  lines.push('Attendees (research is illustrative/mock):')
  research.forEach((p) => {
    lines.push(`  - ${p.name}, ${p.title} — ${p.education}`)
    lines.push(`    ${p.summary}`)
  })
  return lines.join('\n')
}

export async function composeBrief({ bundle, openaiChat }) {
  try {
    const { system, user } = buildPrompt(bundle)
    const brief = await openaiChat({ system, user })
    if (!brief || !String(brief).trim()) throw new Error('empty completion')
    return { brief: String(brief).trim(), source: 'openai' }
  } catch (err) {
    return { brief: renderTemplateBrief(bundle), source: 'template' }
  }
}
