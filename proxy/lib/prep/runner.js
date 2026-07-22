import { gatherAccountData } from './gather.js'
import { mockRfps, mockAttendeeResearch, mockCalendar } from './mock.js'
import { composeBrief } from './compose.js'
import { buildMeetingPrepRecord, writeMeetingPrep } from './record.js'

export async function runPrepJob({ deps, store, jobId, accountName, transcript }) {
  const { findAccount, runQuery, openaiChat, createRecord } = deps
  try {
    const acc = await findAccount(accountName)
    if (!acc) {
      store.update(jobId, { status: 'failed', error: `No account found matching "${accountName}".` })
      return
    }

    const data = await gatherAccountData({ runQuery, accountId: acc.Id })
    const rfps = mockRfps(data.account)
    const research = mockAttendeeResearch(data.contacts)
    const calendar = mockCalendar(data.account)

    const bundle = { ...data, rfps, research, calendar }
    const { brief, source } = await composeBrief({ bundle, openaiChat })

    const attendees = data.contacts
      .map((c) => (c.title ? `${c.name} (${c.title})` : c.name))
      .join('; ')

    const record = buildMeetingPrepRecord({
      account: data.account,
      brief,
      attendees,
      meetingDate: calendar.date,
      transcript,
      status: 'Ready',
    })
    const recordId = await writeMeetingPrep({ createRecord, record })

    const summary =
      `${data.account.name}: ${data.opportunities.length} opps, ` +
      `${data.metrics.openCaseCount} open case(s). Brief saved (${source}).`
    store.update(jobId, { status: 'done', recordId, summary, briefSource: source })
  } catch (err) {
    store.update(jobId, { status: 'failed', error: String(err?.message || err) })
  }
}
