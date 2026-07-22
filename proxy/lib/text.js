// Pull the likely account name out of a natural-language request.
export function extractAccountName(text) {
  let s = String(text || '').trim()
  const conn = s.match(/\b(?:about|for|on|of|regarding|called|named|with)\s+(.+)$/i)
  if (conn) {
    s = conn[1]
  } else {
    s = s.replace(
      /^\s*(?:hey\s+\w+[,\s]+)?(?:show me|show|tell me|give me|find me|find|get me|get|search for|search|look up|pull up|open|prep(?:are)?(?: me)?|what(?:'s| is| are)?|whats|details? of|details? about|info(?:rmation)? about)\s+/i,
      '',
    )
  }
  s = s
    .replace(/\b(?:the|all|my|any|some)\b/gi, ' ')
    .replace(/\b(?:details?|information|info|account|accounts|opportunit(?:y|ies)|opps|pipeline|deals?|records?|meeting|please|thanks?|thank you)\b/gi, ' ')
    .replace(/[^\w\s,&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,;:!?'"&-]+|[\s.,;:!?'"&-]+$/g, '')
    .trim()
  return s
}

export const normalizeName = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
