import {
  accountByIdSoql,
  opportunitiesSoql,
  casesSoql,
  contactsSoql,
} from './queries.js'

export async function gatherAccountData({ runQuery, accountId }) {
  const [accRecs, oppRecs, caseRecs, contactRecs] = await Promise.all([
    runQuery(accountByIdSoql(accountId)),
    runQuery(opportunitiesSoql(accountId)),
    runQuery(casesSoql(accountId)),
    runQuery(contactsSoql(accountId)),
  ])

  const a = accRecs[0] || { Id: accountId, Name: '(unknown)' }
  const account = {
    id: a.Id,
    name: a.Name,
    industry: a.Industry ?? null,
    type: a.Type ?? null,
    website: a.Website ?? null,
    phone: a.Phone ?? null,
    annualRevenue: a.AnnualRevenue ?? null,
    city: a.BillingCity ?? null,
    state: a.BillingState ?? null,
    description: a.Description ?? null,
    lastActivityDate: a.LastActivityDate ?? null,
  }

  const opportunities = oppRecs.map((o) => ({
    id: o.Id,
    name: o.Name,
    amount: o.Amount ?? 0,
    stage: o.StageName,
    closeDate: o.CloseDate ?? null,
    isClosed: !!o.IsClosed,
    isWon: !!o.IsWon,
  }))

  const cases = caseRecs.map((c) => ({
    id: c.Id,
    number: c.CaseNumber,
    subject: c.Subject,
    status: c.Status,
    priority: c.Priority ?? null,
    createdDate: c.CreatedDate ?? null,
    isClosed: !!c.IsClosed,
  }))

  const contacts = contactRecs.map((p) => ({
    id: p.Id,
    name: p.Name,
    title: p.Title ?? null,
    email: p.Email ?? null,
    department: p.Department ?? null,
  }))

  const totalPipeline = opportunities.reduce((s, o) => s + (o.amount || 0), 0)
  const openPipeline = opportunities
    .filter((o) => !o.isClosed)
    .reduce((s, o) => s + (o.amount || 0), 0)
  const openCaseCount = cases.filter((c) => !c.isClosed).length
  const wonCount = opportunities.filter((o) => o.isWon).length

  return {
    account,
    opportunities,
    cases,
    contacts,
    metrics: { totalPipeline, openPipeline, openCaseCount, wonCount },
  }
}
