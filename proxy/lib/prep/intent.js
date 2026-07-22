import { extractAccountName } from '../text.js'

const PREP_RE = /\b(prep|prepare|prepping|briefing|brief me|get me ready|meeting notes|prep notes)\b/i

export function parsePrepIntent(text) {
  const s = String(text || '')
  const isPrep = PREP_RE.test(s)
  const name = extractAccountName(s)
  return { isPrep, accountName: name && name.length ? name : null }
}
