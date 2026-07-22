export function fallbackSummary({ transcript }) {
  const text = String(transcript || '').trim()
  const summary = text ? text.slice(0, 1000) : 'No conversation was captured.'
  return { summary, actionItems: [], nextSteps: [] }
}

export function buildSummaryPrompt({ accountName, transcript }) {
  const system =
    'You are a sales meeting scribe. Summarize the meeting transcript for the CRM. ' +
    'Respond with ONLY a JSON object of the form ' +
    '{"summary": string, "actionItems": string[], "nextSteps": string[]}. ' +
    'Keep the summary under 200 words; each list item one short line. No prose outside the JSON.'
  const user =
    `Account: ${accountName}\n\nTranscript:\n${String(transcript || '').slice(0, 12000) || '(empty)'}`
  return { system, user }
}

function toStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return []
}

export async function composeMeetingSummary({ accountName, transcript, openaiChat }) {
  try {
    const { system, user } = buildSummaryPrompt({ accountName, transcript })
    const reply = await openaiChat({ system, user })
    const raw = String(reply || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(raw)
    const summary = String(parsed.summary || '').trim()
    if (!summary) throw new Error('empty summary')
    return {
      summary,
      actionItems: toStringArray(parsed.actionItems),
      nextSteps: toStringArray(parsed.nextSteps),
      source: 'openai',
    }
  } catch {
    return { ...fallbackSummary({ transcript }), source: 'template' }
  }
}
