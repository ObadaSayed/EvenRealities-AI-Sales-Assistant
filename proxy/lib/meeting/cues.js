export function fallbackCues({ prepPoints }) {
  return (prepPoints || []).slice(0, 3)
}

export function buildCuesPrompt({ prepPoints, transcript, delta }) {
  const system =
    'You are a real-time sales meeting assistant. Given the pre-meeting talking ' +
    'points and the recent conversation transcript, output up to 3 very short cue ' +
    'lines (max ~60 chars each) the salesperson should say or ask NEXT. Imperative, ' +
    'specific to what was just said. Return only the cues, one per line, no numbering.'
  const points = (prepPoints || []).map((p) => `- ${p}`).join('\n') || '(none)'
  const deltaPart = delta && delta.trim().length >= 5
    ? `\nThey just said: "${delta.trim()}"\n`
    : ''
  const user =
    `Pre-meeting talking points:\n${points}\n\n` +
    `Recent conversation:\n${String(transcript || '').slice(-1500) || '(nothing yet)'}` +
    deltaPart
  return { system, user }
}

function parseCues(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
}

export async function composeCues({ prepPoints, transcript, delta, openaiChat }) {
  try {
    const { system, user } = buildCuesPrompt({ prepPoints, transcript, delta })
    const reply = await openaiChat({ system, user })
    const cues = parseCues(reply)
    if (cues.length === 0) throw new Error('empty completion')
    return { cues, source: 'openai' }
  } catch {
    return { cues: fallbackCues({ prepPoints }), source: 'prep' }
  }
}
