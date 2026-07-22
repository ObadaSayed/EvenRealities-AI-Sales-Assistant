import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import jsforce from 'jsforce'
import { extractAccountName, normalizeName } from './lib/text.js'
import { makePrepRouter } from './routes/prep.js'
import { makeDetailRouter } from './routes/detail.js'
import { makeMeetingRouter } from './routes/meeting.js'
import { createMeetingStore } from './lib/meeting/session.js'
import { composeTalkingPoints } from './lib/detail/talkingPoints.js'
import { gatherAccountData } from './lib/prep/gather.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 3000
const SF_TARGET_ORG = process.env.SF_TARGET_ORG || 'evenTest'
const SFDX_AUTH_URL = process.env.SFDX_AUTH_URL

// Speech-to-text (optional). When set, /voice transcribes uploaded PCM audio.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// Agentforce Agent API (optional). When SEARCH_MODE=agent and these are set,
// /ask and /voice route the transcript to a live Agentforce agent; on any
// agent error we fall back to the SOQL search so the demo never dead-ends.
//   AF_MY_DOMAIN: org My Domain URL (Setup -> My Domain -> Current My Domain URL).
//                 Used for BOTH the token request and instanceConfig.endpoint --
//                 mismatching these is the classic Agent API 404.
const AF_AGENT_ID = process.env.AF_AGENT_ID
const AF_MY_DOMAIN = (process.env.AF_MY_DOMAIN || '').replace(/\/+$/, '')
const AF_CLIENT_ID = process.env.AF_CLIENT_ID
const AF_CLIENT_SECRET = process.env.AF_CLIENT_SECRET
const AF_API_BASE = process.env.AF_API_BASE || 'https://api.salesforce.com/einstein/ai-agent/v1'
const SEARCH_MODE = (process.env.SEARCH_MODE || 'soql').toLowerCase()

// Slack DM integration (optional). When set, /slack-ask sends a message to
// Slackbot as a DM and polls for the reply.
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || 'USLACKBOT'
const agentConfigured = Boolean(
  AF_AGENT_ID && AF_MY_DOMAIN && AF_CLIENT_ID && AF_CLIENT_SECRET,
)

const ACCOUNTS_SOQL =
  'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 5'

// Two auth modes:
//  - Heroku/production: SFDX_AUTH_URL config var -> jsforce connection (headless).
//  - Local dev: reuse the `sf` CLI session created by `sf org login web`.
// The auth-url form is: force://<clientId>:<clientSecret>:<refreshToken>@<instanceUrl>
// For a CLI web login the clientId is "PlatformCLI" and clientSecret is empty.
async function connectViaAuthUrl(authUrl) {
  const match = authUrl
    .trim()
    .match(/^force:\/\/([^:]*):([^:]*):([^@]+)@(.+)$/)
  if (!match) throw new Error('Malformed SFDX_AUTH_URL')
  const [, clientId, clientSecret, refreshToken, instanceHost] = match
  const instanceUrl = instanceHost.startsWith('http')
    ? instanceHost
    : `https://${instanceHost}`

  const oauth2 = new jsforce.OAuth2({
    loginUrl: instanceUrl,
    clientId: clientId || 'PlatformCLI',
    clientSecret: clientSecret || undefined,
  })

  // Explicitly exchange the refresh token for a fresh access token so the
  // first query has a valid session (don't rely on lazy refresh).
  const tokenResponse = await oauth2.refreshToken(refreshToken)

  return new jsforce.Connection({
    oauth2,
    instanceUrl: tokenResponse.instance_url || instanceUrl,
    accessToken: tokenResponse.access_token,
    refreshToken,
  })
}

// Reuse a single jsforce connection across requests; it auto-refreshes.
let connPromise = null
function getConnection() {
  if (!connPromise) connPromise = connectViaAuthUrl(SFDX_AUTH_URL)
  return connPromise
}

async function runQuery(soql) {
  if (SFDX_AUTH_URL) {
    const conn = await getConnection()
    const result = await conn.query(soql)
    return result.records
  }
  const { stdout } = await execFileAsync(
    'sf',
    ['data', 'query', '--query', soql, '--target-org', SF_TARGET_ORG, '--json'],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  return JSON.parse(stdout).result.records
}

// Salesforce IDs are 15 or 18 alphanumeric chars. Validate before interpolating.
function assertValidId(id) {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(id || '')) {
    const e = new Error('invalid_account_id')
    e.status = 400
    throw e
  }
}

// Escape a value for safe use inside single-quoted SOQL string literals.
function soqlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function getAccounts() {
  const records = await runQuery(ACCOUNTS_SOQL)
  return records.map((r) => ({ id: r.Id, name: r.Name }))
}

async function getOpportunitiesForAccount({ accountId, accountName }) {
  let whereClause
  let account
  if (accountId) {
    assertValidId(accountId)
    whereClause = `AccountId = '${accountId}'`
    const accRecs = await runQuery(
      `SELECT Id, Name FROM Account WHERE Id = '${accountId}' LIMIT 1`,
    )
    account = accRecs[0]
      ? { id: accRecs[0].Id, name: accRecs[0].Name }
      : { id: accountId, name: '(unknown)' }
  } else {
    whereClause = `Account.Name = '${soqlEscape(accountName)}'`
    account = { id: null, name: accountName }
  }

  const records = await runQuery(
    `SELECT Id, Name, Amount, StageName, IsClosed, IsWon ` +
      `FROM Opportunity WHERE ${whereClause} ORDER BY Amount DESC NULLS LAST`,
  )

  const opportunities = records.map((r) => ({
    id: r.Id,
    name: r.Name,
    amount: r.Amount ?? 0,
    stage: r.StageName,
    isClosed: !!r.IsClosed,
    isWon: !!r.IsWon,
  }))

  const totalAmount = opportunities.reduce((sum, o) => sum + (o.amount || 0), 0)
  const openAmount = opportunities
    .filter((o) => !o.isClosed)
    .reduce((sum, o) => sum + (o.amount || 0), 0)

  return {
    account,
    count: opportunities.length,
    totalAmount,
    openAmount,
    opportunities,
  }
}

function money(n) {
  return '$' + Math.round(n || 0).toLocaleString('en-US')
}

// --- On-demand SOQL search --------------------------------------------------
// Turns a spoken request like "show me details about NetAssist" or
// "open opportunities for Acme" into a SOQL lookup and a display-ready answer.

// Find the best-matching account. Handles STT quirks like "net assist" vs
// "NetAssist" by falling back to per-token search + JS fuzzy scoring.
const ACCOUNT_FIELDS =
  'Id, Name, Industry, Type, Website, Phone, AnnualRevenue, BillingCity, BillingState'

async function findAccount(name) {
  const clean = String(name || '').trim()
  if (!clean) return null

  let recs = await runQuery(
    `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Name LIKE '%${soqlEscape(clean)}%' ` +
      `ORDER BY CreatedDate DESC LIMIT 10`,
  )

  if (!recs.length) {
    const tokens = clean
      .split(/\s+/)
      .map((t) => t.replace(/[^\w'-]/g, ''))
      .filter((t) => t.length >= 3)
    if (tokens.length) {
      const clauses = tokens.map((t) => `Name LIKE '%${soqlEscape(t)}%'`).join(' OR ')
      recs = await runQuery(
        `SELECT ${ACCOUNT_FIELDS} FROM Account WHERE ${clauses} ORDER BY CreatedDate DESC LIMIT 25`,
      )
    }
  }
  if (!recs.length) return null

  const target = normalizeName(clean)
  let best = recs[0]
  let bestScore = -1
  for (const r of recs) {
    const n = normalizeName(r.Name)
    let score
    if (n === target) score = 1000
    else if (n.includes(target)) score = 500 - (n.length - target.length)
    else if (target.includes(n)) score = 400 - (target.length - n.length)
    else score = 0
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}

async function searchSalesforce(text) {
  const wantsOpen = /\bopen\b/i.test(text)
  const name = extractAccountName(text)
  if (!name) {
    return {
      answer:
        'I didn\'t catch an account name. Try: "show me details about NetAssist".',
    }
  }

  const acc = await findAccount(name)
  if (!acc) {
    return { answer: `No account found matching "${name}".` }
  }

  const data = await getOpportunitiesForAccount({ accountId: acc.Id })
  const list = wantsOpen
    ? data.opportunities.filter((o) => !o.isClosed)
    : data.opportunities
  const sum = list.reduce((s, o) => s + (o.amount || 0), 0)

  const detail = []
  if (acc.Industry) detail.push(`Industry: ${acc.Industry}`)
  if (acc.Type) detail.push(acc.Type)
  const loc = [acc.BillingCity, acc.BillingState].filter(Boolean).join(', ')
  if (loc) detail.push(loc)
  if (acc.AnnualRevenue) detail.push(`Rev ${money(acc.AnnualRevenue)}`)

  const scope = wantsOpen ? 'open ' : ''
  const header =
    `${acc.Name}\n` +
    (detail.length ? detail.join('  |  ') + '\n' : '') +
    `\nPipeline: ${money(sum)}  (${list.length} ${scope}opp${list.length === 1 ? '' : 's'})`
  const lines = list
    .slice(0, 6)
    .map((o, i) => `${i + 1}. ${o.name} - ${money(o.amount)} (${o.stage})`)
    .join('\n')

  return {
    source: 'soql',
    answer: list.length ? `${header}\n\n${lines}` : header,
    data: {
      account: {
        id: acc.Id,
        name: acc.Name,
        industry: acc.Industry ?? null,
        type: acc.Type ?? null,
      },
      count: list.length,
      totalAmount: sum,
    },
  }
}

// --- Agentforce Agent API ---------------------------------------------------
// Client Credentials -> session -> message. Token is minted from the org My
// Domain and the SAME My Domain is passed as instanceConfig.endpoint (required;
// a mismatch is the usual source of 404s). See Agent API troubleshooting docs.

async function agentforceToken() {
  const res = await fetch(`${AF_MY_DOMAIN}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AF_CLIENT_ID,
      client_secret: AF_CLIENT_SECRET,
    }),
  })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`agentforce token ${res.status}: ${body.slice(0, 300)}`)
  }
  return JSON.parse(body).access_token
}

// Mint a token and open a session. Split out so callers (e.g. /voice) can start
// this in parallel with speech-to-text and save round-trips against Heroku's
// 30s request limit.
async function createAgentSession() {
  const token = await agentforceToken()
  const sessionRes = await fetch(`${AF_API_BASE}/agents/${AF_AGENT_ID}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      externalSessionKey: randomUUID(),
      instanceConfig: { endpoint: AF_MY_DOMAIN },
      streamingCapabilities: { chunkTypes: ['Text'] },
      bypassUser: true,
    }),
  })
  const sessionBody = await sessionRes.text()
  if (!sessionRes.ok) {
    throw new Error(`agentforce session ${sessionRes.status}: ${sessionBody.slice(0, 400)}`)
  }
  const sessionId = JSON.parse(sessionBody).sessionId
  if (!sessionId) throw new Error('agentforce session: no sessionId returned')
  return { token, sessionId }
}

async function sendAgentMessage({ token, sessionId }, text) {
  try {
    const msgRes = await fetch(`${AF_API_BASE}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { sequenceId: Date.now(), type: 'Text', text },
        variables: [],
      }),
    })
    const msgBody = await msgRes.text()
    if (!msgRes.ok) {
      throw new Error(`agentforce message ${msgRes.status}: ${msgBody.slice(0, 400)}`)
    }
    const answer = (JSON.parse(msgBody).messages || [])
      .map((m) => m.message)
      .filter(Boolean)
      .join('\n\n')
    return { source: 'agent', answer: answer || '(no answer from agent)' }
  } finally {
    // Best-effort session close (don't fail the request on cleanup).
    fetch(`${AF_API_BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  }
}

async function askAgentforce(text) {
  const session = await createAgentSession()
  return sendAgentMessage(session, text)
}

// Dispatcher: agent when configured/selected, else SOQL. Falls back to SOQL on
// any agent error so a live demo always returns something useful.
async function runSearch(text) {
  if (SEARCH_MODE === 'agent' && agentConfigured) {
    try {
      return await askAgentforce(text)
    } catch (err) {
      console.error('agent failed, falling back to SOQL:', err?.message || err)
      const soql = await searchSalesforce(text)
      return { ...soql, source: 'soql-fallback' }
    }
  }
  return searchSalesforce(text)
}

// --- Speech-to-text (OpenAI Whisper) ---------------------------------------
// Wraps raw PCM16 mono 16kHz (as sent by the glasses mic) into a WAV and
// transcribes it. Requires OPENAI_API_KEY.
function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const numChannels = 1
  const byteRate = sampleRate * numChannels * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcmBuffer.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(numChannels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcmBuffer.length, 40)
  return Buffer.concat([header, pcmBuffer])
}

async function transcribePcm(pcmBase64) {
  if (!OPENAI_API_KEY) {
    const e = new Error('stt_not_configured')
    e.status = 501
    throw e
  }
  const wav = pcm16ToWav(Buffer.from(pcmBase64, 'base64'))
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-1')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(`stt failed: ${res.status}`)
  const data = await res.json()
  return data.text
}

// Chat completion used to compose the meeting brief. Throws on any error so
// composeBrief can fall back to its deterministic template.
async function openaiChat({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error('openai_not_configured')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
    }),
  })
  if (!res.ok) throw new Error(`openai chat ${res.status}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// A jsforce connection with write scope. On Heroku we already build one from
// SFDX_AUTH_URL; locally we borrow the sf CLI session's access token (fetched
// fresh each call so an expired token never gets cached).
async function getWriteConnection() {
  if (SFDX_AUTH_URL) return getConnection() // existing helper (auth-url mode)
  const { stdout } = await execFileAsync(
    'sf',
    ['org', 'display', '--target-org', SF_TARGET_ORG, '--json'],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  const r = JSON.parse(stdout).result
  return new jsforce.Connection({
    instanceUrl: r.instanceUrl,
    accessToken: r.accessToken,
  })
}

async function createRecord(sobject, fields) {
  const conn = await getWriteConnection()
  const result = await conn.sobject(sobject).create(fields)
  if (!result.success) {
    throw new Error(`create ${sobject} failed: ${JSON.stringify(result.errors)}`)
  }
  return { id: result.id }
}

const meetingStore = createMeetingStore()

async function loadPrepContext(accountId) {
  try {
    assertValidId(accountId)
    const prepRows = await runQuery(
      `SELECT Id FROM Meeting_Prep__c WHERE Account__c = '${accountId}' ORDER BY CreatedDate DESC LIMIT 1`,
    )
    const prepId = prepRows?.[0]?.Id ?? null
    const bundle = await gatherAccountData({ runQuery, accountId })
    const { points } = await composeTalkingPoints({ bundle, openaiChat })
    return { prepId, prepPoints: points || [] }
  } catch {
    return { prepId: null, prepPoints: [] }
  }
}

const app = express()
app.use(cors()) // Access-Control-Allow-Origin: * + preflight handling
app.use(express.json({ limit: '20mb' }))

app.use(
  makePrepRouter({
    transcribePcm,
    findAccount,
    runQuery,
    openaiChat,
    createRecord,
  }),
)

app.use(makeDetailRouter({ runQuery, openaiChat }))

app.use(
  makeMeetingRouter({
    transcribePcm,
    openaiChat,
    createRecord,
    store: meetingStore,
    loadPrepContext,
  }),
)

// Serve the built Even Hub app (app/dist copied into ./public at deploy time) so
// the glasses can load it directly from this public URL — no local dev server,
// LAN, or firewall in the loop. API routes below still take precedence since
// there are no matching static files for them.
app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    authMode: SFDX_AUTH_URL ? 'sfdx-auth-url' : 'sf-cli',
    search: SEARCH_MODE === 'agent' && agentConfigured ? 'agent' : 'soql',
    agentConfigured,
    stt: OPENAI_API_KEY ? 'whisper' : 'disabled',
  })
})

// Natural-language request -> Agentforce agent (or SOQL) -> answer text.
app.post('/ask', async (req, res) => {
  const text = req.body?.text
  if (!text) {
    res.status(400).json({ error: 'missing_text' })
    return
  }
  try {
    res.json(await runSearch(String(text)))
  } catch (err) {
    console.error('ask failed:', err)
    res.status(502).json({ error: 'ask_failed', detail: String(err?.message || err) })
  }
})

// Voice: base64 PCM16 (16kHz mono) -> transcript -> agent/SOQL -> answer.
app.post('/voice', async (req, res) => {
  const pcmBase64 = req.body?.audioBase64
  if (!pcmBase64) {
    res.status(400).json({ error: 'missing_audio' })
    return
  }
  try {
    const useAgent = SEARCH_MODE === 'agent' && agentConfigured
    // In agent mode, open the session while STT runs so they overlap.
    const sessionPromise = useAgent ? createAgentSession() : null
    if (sessionPromise) sessionPromise.catch(() => {}) // avoid unhandled rejection

    const transcript = await transcribePcm(pcmBase64)

    let result
    if (sessionPromise) {
      try {
        const session = await sessionPromise
        result = await sendAgentMessage(session, transcript)
      } catch (err) {
        console.error('agent failed, falling back to SOQL:', err?.message || err)
        result = { ...(await searchSalesforce(transcript)), source: 'soql-fallback' }
      }
    } else {
      result = await runSearch(transcript)
    }
    res.json({ transcript, ...result })
  } catch (err) {
    const status = err.status || 502
    console.error('voice failed:', err)
    res.status(status).json({ error: err.message || 'voice_failed', detail: String(err?.message || err) })
  }
})

app.get('/accounts', async (_req, res) => {
  try {
    res.json({ accounts: await getAccounts() })
  } catch (err) {
    console.error('Failed to fetch accounts:', err)
    res.status(502).json({ error: 'salesforce_query_failed', detail: String(err?.message || err) })
  }
})

// On-demand drill-down: opportunities + pipeline sum for one account.
// By id (from list selection): GET /accounts/:id/opportunities
app.get('/accounts/:id/opportunities', async (req, res) => {
  try {
    res.json(await getOpportunitiesForAccount({ accountId: req.params.id }))
  } catch (err) {
    const status = err.status || 502
    console.error('Failed to fetch opportunities:', err)
    res.status(status).json({ error: err.message || 'salesforce_query_failed', detail: String(err?.message || err) })
  }
})

// By name (e.g. voice: "opportunities for NetAssist"): GET /opportunities?account=NetAssist
app.get('/opportunities', async (req, res) => {
  const accountName = req.query.account
  if (!accountName) {
    res.status(400).json({ error: 'missing_account_query_param' })
    return
  }
  try {
    res.json(await getOpportunitiesForAccount({ accountName: String(accountName) }))
  } catch (err) {
    console.error('Failed to fetch opportunities by name:', err)
    res.status(502).json({ error: 'salesforce_query_failed', detail: String(err?.message || err) })
  }
})

// --- Slack DM integration ---------------------------------------------------
// Opens a DM with Slackbot, sends a message, polls conversations.history until
// a reply appears, and returns it. Requires SLACK_USER_TOKEN + SLACK_BOT_USER_ID.

async function slackPost(path, token, body) {
  const res = await fetch(`https://slack.com/api/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`slack ${path} error: ${data.error}`)
  return data
}

async function pollSlackReply(token, channelId, afterTs, maxAttempts = 15, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const res = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${afterTs}&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const data = await res.json()
    if (!data.ok) throw new Error(`slack conversations.history error: ${data.error}`)
    const reply = (data.messages || []).find(
      (m) => m.ts !== afterTs && (m.user === SLACK_BOT_USER_ID || m.bot_id || m.subtype === 'bot_message'),
    )
    if (reply) return reply.text
  }
  throw new Error('Timed out waiting for Slackbot reply')
}

// POST /slack-ask  { "message": "your question" }
// Returns: { "reply": "slackbot response text", "channel": "...", "ts": "..." }
app.post('/slack-ask', async (req, res) => {
  if (!SLACK_USER_TOKEN) {
    res.status(501).json({ error: 'slack_not_configured', detail: 'SLACK_USER_TOKEN not set' })
    return
  }
  const message = req.body?.message
  if (!message) {
    res.status(400).json({ error: 'missing_message' })
    return
  }
  try {
    const { channel } = await slackPost('conversations.open', SLACK_USER_TOKEN, { users: SLACK_BOT_USER_ID })
    console.log('slack channel:', JSON.stringify(channel))
    const { ts } = await slackPost('chat.postMessage', SLACK_USER_TOKEN, {
      channel: channel.id,
      text: String(message),
    })
    console.log('slack sent ts:', ts)
    const reply = await pollSlackReply(SLACK_USER_TOKEN, channel.id, ts)
    res.json({ reply, channel: channel.id, ts })
  } catch (err) {
    console.error('slack-ask failed:', err)
    res.status(502).json({ error: 'slack_ask_failed', detail: String(err?.message || err) })
  }
})

app.listen(PORT, () => {
  console.log(
    `SF->EvenHub proxy listening on :${PORT} (auth: ${SFDX_AUTH_URL ? 'sfdx-auth-url' : 'sf-cli'})`,
  )
})
