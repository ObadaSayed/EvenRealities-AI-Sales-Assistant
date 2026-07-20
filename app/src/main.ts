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

type View = 'accounts' | 'detail' | 'listening' | 'result'

let bridge: Bridge
let accounts: Account[] = []
let selected = 0
let view: View = 'accounts'
let busy = false

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
  try {
    const tp = await fetchJson<TalkingPoints>(`/accounts/${account.id}/talking-points`)
    if (view === 'detail') await setText(renderDetail(detail, tp.points))
    console.log('APP_TP_LOADED', account.name, tp.source)
  } catch (err) {
    if (view === 'detail') await setText(renderDetail(detail, 'error'))
    console.error('APP_TP_ERROR', err)
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
  if (view === 'listening') {
    await cancelListening()
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
