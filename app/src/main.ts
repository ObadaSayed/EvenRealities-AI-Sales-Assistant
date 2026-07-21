import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  StartUpPageCreateResult,
  OsEventTypeList,
  AudioInputSource,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

// Salesforce proxy origin. Override with VITE_PROXY_URL; defaults to Heroku.
// Any origin used here must also be in app.json network.whitelist.
const PROXY_URL =
  import.meta.env.VITE_PROXY_URL ??
  'https://sf-evenhub-proxy-4f011c764460.herokuapp.com'

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

interface Account {
  id: string
  name: string
}
interface StageSlice { stage: string; amount: number }
interface ContactLite { name: string; title: string | null }
interface LastInteraction { date: string; source: string }
interface DetailResult {
  account: { id: string; name: string }
  metrics: { totalPipeline: number; openPipeline: number; openCaseCount: number; wonCount: number }
  stages: StageSlice[]
  contacts: ContactLite[]
  lastInteraction: LastInteraction | null
}
interface TalkingPoints { points: string[]; source: string }
interface VoiceResult {
  transcript?: string
  answer: string
  source?: 'agent' | 'soql' | 'soql-fallback'
}
interface PrepStart { jobId: string; account: string; status: string }
interface PrepStatus {
  status: 'running' | 'done' | 'failed'
  recordId?: string
  summary?: string
  error?: string
  account?: string
}

interface MeetingStart { sessionId: string; cues: string[] }
interface MeetingChunk { transcript: string; cues: string[] }
interface MeetingEnd { summary: string; actionItems: string[]; nextSteps: string[]; recordId: string | null; saved: boolean }

type View = 'accounts' | 'detail' | 'listening' | 'result' | 'meeting' | 'meetingSummary'

let bridge: Bridge
let accounts: Account[] = []
let selected = 0
let view: View = 'accounts'
let busy = false
// Id of the account whose detail view is currently open; used to discard
// stale async talking-points responses from a previously-opened account.
let detailAccountId: string | null = null

let meetingSessionId: string | null = null
let meetingCues: string[] = []
let meetingTranscriptTail = ''
let meetingStartMs = 0
let meetingAccountName = ''
let flushTimer: ReturnType<typeof setInterval> | null = null
const MEETING_FLUSH_MS = 20000

// Voice capture state.
let recording = false
let pcmChunks: Uint8Array[] = []
let captureMode: 'search' | 'prep' = 'search'

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY_URL}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PROXY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function setText(content: string) {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content,
      contentOffset: 0,
      contentLength: 0,
    }),
  )
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// --- Rendering -------------------------------------------------------------

const PREP_ROW = 'Prep meeting (voice)'

function renderAccounts(): string {
  const prepRow = `${selected === 0 ? '>' : ' '} ${PREP_ROW}`
  const rows = accounts
    .map((a, i) => `${i + 1 === selected ? '>' : ' '} ${i + 1}. ${a.name}`)
    .join('\n')
  const exitIdx = accounts.length + 1
  const exitRow = `${selected === exitIdx ? '>' : ' '} Exit to glasses menu`
  return `Salesforce\n\n${prepRow}\n${rows}\n${exitRow}\n\nTap: select  Swipe: move`
}

function bar(value: number, max: number, width = 10): string {
  if (max <= 0) return ''
  const cells = value > 0 ? Math.max(1, Math.round((value / max) * width)) : 0
  return '█'.repeat(cells)
}

function daysAgo(dateStr: string): string {
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return dateStr
  const days = Math.floor((Date.now() - then) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function renderDetail(d: DetailResult, points?: string[] | 'error'): string {
  const head =
    `${d.account.name}\n` +
    `Pipeline ${money(d.metrics.totalPipeline)} · Open ${money(d.metrics.openPipeline)}\n`
  let chart: string
  if (d.stages.length) {
    const max = Math.max(...d.stages.map((s) => s.amount))
    chart =
      '\nOpen by stage\n' +
      d.stages
        .slice(0, 4)
        .map((s) => ` ${s.stage} ${bar(s.amount, max)} ${money(s.amount)}`)
        .join('\n') +
      '\n'
  } else {
    chart = '\nNo open pipeline\n'
  }
  const contacts = d.contacts.length
    ? '\nMain contacts\n' +
      d.contacts.map((c) => ` ${c.name}${c.title ? ' — ' + c.title : ''}`).join('\n') +
      '\n'
    : '\nNo contacts on file\n'
  const last = d.lastInteraction
    ? `Last interaction  ${daysAgo(d.lastInteraction.date)}\n`
    : 'No recent activity\n'
  let tp = '\nKey talking points  (analyzing…)\n'
  if (points === 'error') {
    tp = '\nKey talking points  (unavailable)\n'
  } else if (points && points.length) {
    tp = '\nKey talking points\n' + points.map((p) => ` • ${p}`).join('\n') + '\n'
  }
  return `${head}${chart}${contacts}${last}${tp}\nTap: back  x2: ask by voice`
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function renderMeeting(o: { accountName: string; elapsedMs: number; cues: string[]; transcriptTail: string }): string {
  const head = `● REC ${fmtElapsed(o.elapsedMs)}   ${o.accountName}\n`
  const cues = o.cues.length
    ? '\nLive cues\n' + o.cues.map((c) => ` • ${c}`).join('\n') + '\n'
    : '\nLive cues\n (listening…)\n'
  const tail = o.transcriptTail ? `\n"${o.transcriptTail}"\n` : ''
  return `${head}${cues}${tail}\nTap: end & save   x2: discard`
}

function renderMeetingSummary(r: MeetingEnd, accountName: string): string {
  const ai = r.actionItems.length ? '\nAction items\n' + r.actionItems.map((x) => ` • ${x}`).join('\n') + '\n' : ''
  const ns = r.nextSteps.length ? '\nNext steps\n' + r.nextSteps.map((x) => ` • ${x}`).join('\n') + '\n' : ''
  const status = r.saved ? 'Saved to Salesforce ✓' : 'NOT saved — Salesforce write failed'
  return `Meeting ${r.saved ? 'saved' : 'ended'}  ${accountName}\n\nSummary\n ${r.summary}\n${ai}${ns}\n${status} · Tap: back`
}

// --- Actions ---------------------------------------------------------------

async function showAccounts() {
  view = 'accounts'
  await setText(renderAccounts())
}

async function moveCursor(delta: number) {
  if (view !== 'accounts' || accounts.length === 0) return
  const n = accounts.length + 2 // prep row + accounts + exit row
  selected = (selected + delta + n) % n
  await setText(renderAccounts())
}

async function loadAccounts() {
  if (busy) return
  busy = true
  try {
    const data = await fetchJson<{ accounts: Account[] }>('/accounts')
    accounts = data.accounts ?? []
    selected = 0
    await showAccounts()
    console.log('APP_ACCOUNTS_LOADED', accounts.length)
  } catch (err) {
    view = 'detail'
    await setText(`Error loading Accounts\n\n${(err as Error).message}`)
    console.error('APP_ACCOUNTS_ERROR', err)
  } finally {
    busy = false
  }
}

async function openSelectedAccount() {
  const account = accounts[selected - 1]
  if (!account) return
  if (busy) return
  busy = true
  view = 'detail'
  detailAccountId = account.id
  let detail: DetailResult
  try {
    await setText(`${account.name}\n\nLoading...`)
    detail = await fetchJson<DetailResult>(`/accounts/${account.id}/detail`)
    await setText(renderDetail(detail))
    console.log('APP_DETAIL_LOADED', account.name)
  } catch (err) {
    await setText(
      `${account.name}\n\nError loading detail\n\n${(err as Error).message}\n\nTap: back`,
    )
    console.error('APP_DETAIL_ERROR', err)
    busy = false
    return
  }
  // Allow tap-back while talking points are generated.
  busy = false
  const isCurrent = () => view === 'detail' && detailAccountId === account.id
  try {
    const tp = await fetchJson<TalkingPoints>(`/accounts/${account.id}/talking-points`)
    if (isCurrent()) await setText(renderDetail(detail, tp.points))
    console.log('APP_TP_LOADED', account.name, tp.source)
  } catch (err) {
    if (isCurrent()) await setText(renderDetail(detail, 'error'))
    console.error('APP_TP_ERROR', err)
  }
}

async function startMeeting(account: Account) {
  if (busy || recording) return
  busy = true
  try {
    const s = await postJson<MeetingStart>('/meeting/start', { accountId: account.id })
    meetingSessionId = s.sessionId
    meetingCues = s.cues || []
    meetingTranscriptTail = ''
    meetingStartMs = Date.now()
    meetingAccountName = account.name
    view = 'meeting'
    recording = true
    pcmChunks = []
    await bridge.audioControl(true, AudioInputSource.Glasses)
    await renderMeetingScreen()
    flushTimer = setInterval(() => { void flushMeetingChunk() }, MEETING_FLUSH_MS)
  } catch (err) {
    await setText(`${account.name}\n\nCould not start meeting\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_MEETING_START_ERROR', err)
  } finally {
    busy = false
  }
}

async function renderMeetingScreen() {
  await setText(renderMeeting({
    accountName: meetingAccountName,
    elapsedMs: Date.now() - meetingStartMs,
    cues: meetingCues,
    transcriptTail: meetingTranscriptTail,
  }))
}

function snapshotPcm(): Uint8Array {
  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length }
  pcmChunks = []
  return merged
}

async function flushMeetingChunk() {
  if (!meetingSessionId || view !== 'meeting') return
  const merged = snapshotPcm()
  try {
    if (merged.length > 0) {
      const audioBase64 = uint8ToBase64(merged)
      const r = await postJson<MeetingChunk>(`/meeting/${meetingSessionId}/chunk`, { audioBase64 })
      meetingCues = r.cues || meetingCues
      if (r.transcript) meetingTranscriptTail = r.transcript.slice(-120)
    }
  } catch (err) {
    console.error('APP_MEETING_CHUNK_ERROR', err)
  }
  if (view === 'meeting') await renderMeetingScreen()
}

async function endMeeting(save: boolean) {
  if (!meetingSessionId) return
  const sessionId = meetingSessionId
  const accountName = meetingAccountName
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  recording = false
  try { await bridge.audioControl(false) } catch { /* ignore */ }
  busy = true
  try {
    if (save) {
      const merged = snapshotPcm()
      if (merged.length > 0) {
        try {
          await postJson<MeetingChunk>(`/meeting/${sessionId}/chunk`, { audioBase64: uint8ToBase64(merged) })
        } catch { /* best-effort final chunk */ }
      }
      await setText(`${accountName}\n\nSummarizing & saving…`)
      const r = await postJson<MeetingEnd>(`/meeting/${sessionId}/end`, {})
      view = 'meetingSummary'
      await setText(renderMeetingSummary(r, accountName))
    } else {
      view = 'accounts'
      meetingSessionId = null
      await showAccounts()
    }
  } catch (err) {
    view = 'meetingSummary'
    await setText(`${accountName}\n\nMeeting ended but summary failed\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_MEETING_END_ERROR', err)
  } finally {
    meetingSessionId = null
    busy = false
  }
}

async function exitApp() {
  try {
    await bridge.shutDownPageContainer(1) // 1 = system exit-confirmation, returns to native
    console.log('APP_EXIT')
  } catch (err) {
    console.error('APP_EXIT_ERROR', err)
  }
}

// --- Voice search ----------------------------------------------------------

async function startListening(mode: 'search' | 'prep' = 'search') {
  if (busy || recording) return
  captureMode = mode
  recording = true
  pcmChunks = []
  view = 'listening'
  const hint =
    mode === 'prep'
      ? 'Prep: say e.g. "prep me for the Omega meeting"'
      : 'Say e.g. "show me details about NetAssist"'
  await setText(`Listening...\n\n${hint}\n\nTap: send   x2: cancel`)
  try {
    await bridge.audioControl(true, AudioInputSource.Glasses)
    console.log('APP_MIC_ON', mode)
  } catch (err) {
    recording = false
    await setText(`Mic error\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_MIC_ERROR', err)
  }
}

async function cancelListening() {
  if (!recording) return
  recording = false
  try {
    await bridge.audioControl(false)
  } catch {
    /* ignore */
  }
  pcmChunks = []
  await showAccounts()
}

async function stopListeningAndSearch() {
  if (!recording) return
  recording = false
  try {
    await bridge.audioControl(false)
  } catch {
    /* ignore */
  }

  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  console.log('APP_MIC_OFF', 'bytes', total)
  if (total === 0) {
    await setText('No audio captured.\n\nTap: back  x2: ask again')
    view = 'result'
    return
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of pcmChunks) {
    merged.set(c, offset)
    offset += c.length
  }
  pcmChunks = []

  busy = true
  view = 'result'
  try {
    await setText('Searching Salesforce...')
    const audioBase64 = uint8ToBase64(merged)
    const result = await postJson<VoiceResult>('/voice', { audioBase64 })
    const heard = result.transcript ? `You: "${result.transcript}"\n\n` : ''
    const label = result.source === 'agent' ? 'Agent' : 'CRM'
    await setText(`${heard}${label}: ${result.answer}\n\nTap: back  x2: ask again`)
    console.log('APP_VOICE_RESULT', result.source, result.transcript)
  } catch (err) {
    await setText(
      `Voice search failed\n\n${(err as Error).message}\n\nTap: back  x2: ask again`,
    )
    console.error('APP_VOICE_ERROR', err)
  } finally {
    busy = false
  }
}

async function stopListeningAndPrep() {
  if (!recording) return
  recording = false
  try { await bridge.audioControl(false) } catch { /* ignore */ }

  const total = pcmChunks.reduce((n, c) => n + c.length, 0)
  console.log('APP_MIC_OFF', 'bytes', total)
  if (total === 0) {
    view = 'result'
    await setText('No audio captured.\n\nTap: back')
    return
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length }
  pcmChunks = []

  busy = true
  view = 'result'
  try {
    await setText('Preparing brief...')
    const audioBase64 = uint8ToBase64(merged)
    const start = await postJson<PrepStart>('/prep', { audioBase64 })
    await setText(`Preparing brief for ${start.account}...`)
    await pollPrep(start.jobId, start.account)
  } catch (err) {
    await setText(`Prep failed\n\n${(err as Error).message}\n\nTap: back`)
    console.error('APP_PREP_ERROR', err)
  } finally {
    busy = false
  }
}

async function pollPrep(jobId: string, account: string) {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await fetchJson<PrepStatus>(`/prep/${jobId}`)
    if (s.status === 'done') {
      await setText(`Prep ready for ${account}\n\n${s.summary || 'Saved to Salesforce.'}\n\nTap: back`)
      return
    }
    if (s.status === 'failed') {
      await setText(`Prep failed for ${account}\n\n${s.error || ''}\n\nTap: back`)
      return
    }
  }
  await setText(`Still working on ${account} — check Salesforce.\n\nTap: back`)
}

// --- Gestures --------------------------------------------------------------

async function onSingleTap() {
  if (view === 'meeting') { await endMeeting(true); return }
  if (view === 'meetingSummary') { await showAccounts(); return }
  if (view === 'listening') {
    if (captureMode === 'prep') await stopListeningAndPrep()
    else await stopListeningAndSearch()
    return
  }
  if (busy) return
  if (view === 'detail' || view === 'result') {
    await showAccounts()
  } else if (view === 'accounts') {
    if (selected === 0) {
      await startListening('prep')
    } else if (selected === accounts.length + 1) {
      await exitApp()
    } else {
      await openSelectedAccount()
    }
  }
}

async function onDoubleTap() {
  if (view === 'meeting') { await endMeeting(false); return }
  if (view === 'listening') {
    await cancelListening()
    return
  }
  if (view === 'detail') {
    const account = accounts[selected - 1]
    if (account) await startMeeting(account)
    return
  }
  await startListening()
}

// --- Bootstrap -------------------------------------------------------------

async function main() {
  bridge = await waitForEvenAppBridge()

  const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 8,
    containerID: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    content: 'Salesforce\n\nLoading...',
    isEventCapture: 1,
  })

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
  )
  console.log('APP_READY', result === StartUpPageCreateResult.success ? 'ok' : `fail:${result}`)

  bridge.onEvenHubEvent((event: EvenHubEvent) => {
    // Mic PCM frames arrive while recording.
    if (event.audioEvent) {
      if (recording && event.audioEvent.audioPcm?.length) {
        pcmChunks.push(event.audioEvent.audioPcm)
      }
      return
    }
    // Scroll gestures on a text container arrive via textEvent (1=up, 2=down).
    if (event.textEvent) {
      const t = event.textEvent.eventType ?? 0
      if (t === OsEventTypeList.SCROLL_TOP_EVENT) void moveCursor(-1)
      else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) void moveCursor(1)
      return
    }
    // Taps arrive via sysEvent (0/undefined = single, 3 = double).
    const sys = event.sysEvent
    if (!sys) return
    const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void onDoubleTap()
    else if (type === OsEventTypeList.CLICK_EVENT) void onSingleTap()
  })

  await loadAccounts()
}

void main()
