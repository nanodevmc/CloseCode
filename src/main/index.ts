import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell } from 'electron'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import type { Lang } from '../shared/i18n'
import { isImageModel, normalizeEffort, reasoningEffortFor, thinkingBudgetFor } from '../shared/modelNames'
import { filterFreeModels, isFreeProvider } from '../shared/freeModels'
import type {
  AgentEvent,
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequest,
  AppearancePayload,
  ChatAttachment,
  ContextState,
  EffortLevel,
  ExportChatPayload,
  FetchModelsPayload,
  ProviderView,
  RestoredMessage,
  SaveSettingsPayload,
  SecondOpinionPayload,
  SecondOpinionResult,
  SendMessagePayload,
  SetActiveModelPayload,
  TerminalSessionInfo,
  TreePayload,
  UserQuestion,
  WindowBounds,
  WindowMode,
  WindowState
} from '../shared/types'
import { buildSystemPrompt } from './agent/prompt'
import { runAgent } from './agent/loop'
import {
  buildContextState,
  compactHistoryIfNeeded,
  contextLimitForModel,
  estimateTokens
} from './agent/context'
import { diffStats, projectTree } from './agent/tools'
import { fetchAvailableModels } from './llm/models'
import { generateImage, MAX_IMAGE_BYTES, sniffImageMime } from './llm/images'
import { streamAnthropic } from './llm/anthropic'
import { streamOpenAi } from './llm/openai'
import type { ChatMessage, MessageImage } from './llm/types'
import { flushActivity, getActivity, recordMessage, recordTool } from './activity'
import { modelLoad } from './load'
import { openLibraryDir } from './library'
import { applyUnlockerProxy, getUnlockerStatus, setUnlockerEnabled, importGoogleAntigravityProvider } from './unlocker'
import { remoteControl } from './remoteControl'
import { tr } from './lang'
import {
  clearHistory,
  loadHistory,
  loadTitle,
  loadTranscript,
  saveHistory,
  saveTitle,
  type TranscriptEntry
} from './sessions'
import {
  addAllowedRoot,
  addProject,
  findGrantRoot,
  getAgentProvider,
  getApprovalPolicy,
  getCompactRatio,
  getEffort,
  getEnabledSkills,
  getProjectPath,
  getSettingsView,
  getUiScaleFactor,
  isPathUnder,
  removeProject,
  resolveApiKeyForRequest,
  revokeAllowedRoot,
  saveSettings,
  setActiveModel,
  setActiveProject,
  setAppearanceSetting,
  setApprovalPolicySetting,
  setCompactAtSetting,
  setEffortSetting,
  setLanguageSetting,
  setSecondOpinionSetting,
  setSkillEnabledSetting
} from './settings'

app.setName('CloseCode')
if (process.env.CLOSECODE_USER_DATA) {
  fs.mkdirSync(process.env.CLOSECODE_USER_DATA, { recursive: true })
  app.setPath('userData', process.env.CLOSECODE_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let running = false
let runController: AbortController | null = null
let terminal: { id: string; pty: IPty } | null = null
let terminalSeq = 0
let history: ChatMessage[] = []
let transcript: TranscriptEntry[] = []
let currentTitle = ''
let privateSession = false
let loadTimer: NodeJS.Timeout | null = null
const pendingApprovals = new Map<string, (answer: ApprovalAnswer) => void>()
const pendingQuestions = new Map<string, (answer: string) => void>()
const toolNames = new Map<string, string>()
const generatedImages = new Set<string>()

const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_CHARS = 200_000
const MAX_TOTAL_ATTACHMENT_CHARS = 500_000

const SCREEN_PIXEL_LIMIT = 2560
const SCREEN_MAX_WIDTH = 1920
const SCREEN_KEEP = 20

const MAX_QUESTIONS_PER_RUN = 3

const WINDOW_SIZES: Record<
  WindowMode,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  app: { width: 1200, height: 800, minWidth: 900, minHeight: 620 },
  terminal: { width: 640, height: 460, minWidth: 460, minHeight: 320 }
}

let preferredAppBounds: Electron.Rectangle | null = null

const TITLE_SYSTEM = `You name coding tasks. Given the user's first request, answer with one short title of 3 to 6 words.
Rules: use the language of the request, no quotes, no markdown, no trailing period, no explanations.
Examples: "Fix login redirect loop", "Add seasonal activity chart", "Разобрать структуру проекта".`

function windowState(): WindowState {
  if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, fullscreen: false }
  return {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen()
  }
}

function emitWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:state-changed', windowState())
}

function fitWindow(width: number, height: number, animate: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const current = mainWindow.getBounds()
  const area = screen.getDisplayMatching(current).workArea
  const nextWidth = Math.min(width, area.width)
  const nextHeight = Math.min(height, area.height)
  const x = Math.round(
    Math.min(Math.max(current.x + (current.width - nextWidth) / 2, area.x), area.x + area.width - nextWidth)
  )
  const y = Math.round(
    Math.min(
      Math.max(current.y + (current.height - nextHeight) / 2, area.y),
      area.y + area.height - nextHeight
    )
  )
  mainWindow.setBounds({ x, y, width: nextWidth, height: nextHeight }, animate)
}

function applyWindowMode(mode: WindowMode): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const target = WINDOW_SIZES[mode]
  const win = mainWindow
  if (mode === 'terminal') {
    if (!win.isMaximized() && !win.isFullScreen()) preferredAppBounds = win.getBounds()
    if (win.isMaximized()) win.unmaximize()
    win.setMinimumSize(target.minWidth, target.minHeight)
    fitWindow(target.width, target.height, true)
  } else {
    win.setMinimumSize(target.minWidth, target.minHeight)
    if (preferredAppBounds) {
      win.setBounds(preferredAppBounds, true)
      preferredAppBounds = null
    } else {
      fitWindow(target.width, target.height, true)
    }
  }
}

function startShell(cols: number, rows: number): TerminalSessionInfo {
  stopShell()
  const safeCols = Math.min(400, Math.max(20, Math.round(cols) || 100))
  const safeRows = Math.min(200, Math.max(5, Math.round(rows) || 30))
  const project = getProjectPath()
  const cwd = project && fs.existsSync(project) ? project : os.homedir()
  const shellPath =
    process.platform === 'win32'
      ? process.env.CLOSECODE_SHELL || 'powershell.exe'
      : process.env.SHELL || '/bin/bash'
  const isCmd = process.platform === 'win32' && shellPath.toLowerCase().endsWith('cmd.exe')
  const args = isCmd ? [] : process.platform === 'win32' ? ['-NoLogo'] : ['-l']
  const shellEnv: Record<string, string | undefined> = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  delete shellEnv.ELECTRON_RUN_AS_NODE
  const child = spawnPty(shellPath, args, {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd,
    env: shellEnv
  })
  const id = `term-${++terminalSeq}`
  terminal = { id, pty: child }
  child.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data })
    }
  })
  child.onExit(({ exitCode }) => {
    if (terminal?.id === id) terminal = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id, exitCode })
    }
  })
  return { id, shell: path.basename(shellPath), cwd }
}

function stopShell(): void {
  if (!terminal) return
  const current = terminal
  terminal = null
  try {
    current.pty.kill()
  } catch {
  }
}

function cleanGeneratedTitle(raw: string): string {  const first = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return ''
  const title = first
    .replace(/^#+\s*/, '')
    .replace(/^["'«»“”`*\-–—\s]+|["'«»“”`*\-–—\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) return ''
  return title.length > 56 ? `${title.slice(0, 56).trimEnd()}…` : title
}

function generateTaskTitle(
  text: string,
  provider: ReturnType<typeof getAgentProvider>,
  model: string,
  projectPath: string | null
): void {
  const source = text.trim()
  if (!source || currentTitle || !provider) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  timer.unref?.()
  const stream = provider.kind === 'anthropic' ? streamAnthropic : streamOpenAi
  void stream(
    {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model,
      system: TITLE_SYSTEM,
      messages: [{ role: 'user', content: source.slice(0, 4000) }],
      tools: [],
      signal: controller.signal,
      maxTokens: 64,
      temperature: 0.3
    },
    () => undefined
  )
    .then((result) => {
      const title = cleanGeneratedTitle(result.text)
      if (!title) return
      currentTitle = title
      if (!privateSession) saveTitle(projectPath, title)
      emit({ type: 'title', title })
    })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
}

function emit(event: AgentEvent): void {
  remoteControl.broadcastEvent(event)
  if (event.type === 'tool-start') {
    toolNames.set(event.id, event.name)
  } else if (event.type === 'tool-end') {
    const name = toolNames.get(event.id) ?? ''
    toolNames.delete(event.id)
    if (!privateSession) recordTool(name, event.ok)
  } else if (event.type === 'image') {
    generatedImages.add(path.resolve(event.absolutePath))
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:event', event)
  }
}

function activeImageModels(): string[] {
  const view = getSettingsView()
  const provider = view.providers.find((item) => item.id === view.activeProviderId)
  return provider ? provider.models.filter(isImageModel) : []
}

interface ScreenShot {
  buffer: Buffer
  mime: string
  width: number
  height: number
  label: string
  displays: number
}

async function captureDisplay(display: number): Promise<ScreenShot> {
  const displays = screen.getAllDisplays()
  if (!displays.length) throw new Error(tr('e.noScreen'))
  const index = Math.min(Math.max(0, Math.trunc(display) || 0), displays.length - 1)
  const target = displays[index]
  const scale = target.scaleFactor || 1
  const size = {
    width: Math.round((target.size?.width ?? target.bounds.width) * scale),
    height: Math.round((target.size?.height ?? target.bounds.height) * scale)
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.min(SCREEN_PIXEL_LIMIT, size.width),
      height: Math.min(SCREEN_PIXEL_LIMIT, size.height)
    }
  })
  const source = sources.find((item) => item.display_id === String(target.id)) ?? sources[index]
  if (!source || source.thumbnail.isEmpty()) throw new Error(tr('e.noScreen'))
  let image = source.thumbnail
  if (image.getSize().width > SCREEN_MAX_WIDTH) {
    image = image.resize({ width: SCREEN_MAX_WIDTH })
  }
  return {
    buffer: image.toPNG(),
    mime: 'image/png',
    width: image.getSize().width,
    height: image.getSize().height,
    label: source.name?.trim() || `${tr('screen.display')} ${index + 1}`,
    displays: displays.length
  }
}

function screenshotDir(): string {
  const dir = path.join(app.getPath('userData'), 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function saveScreenshot(buffer: Buffer, display: number): string {
  const dir = screenshotDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `screen-${stamp}-${Math.max(1, display)}.png`)
  fs.writeFileSync(file, buffer)
  pruneScreenshots(dir)
  return file
}

function pruneScreenshots(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
    for (const file of files.slice(SCREEN_KEEP)) {
      try {
        fs.rmSync(path.join(dir, file.name))
      } catch {
      }
    }
  } catch {
  }
}

function currentSystem(): string {
  const view = getSettingsView()
  return buildSystemPrompt({
    projectPath: getProjectPath(),
    effort: getEffort(),
    enabledSkills: getEnabledSkills(),
    imageModels: activeImageModels(),
    projects: view.projects.map((project) => ({ name: project.name, path: project.path })),
    screen: true
  })
}

function currentContext(): ContextState {
  const model = getSettingsView().activeModel ?? ''
  const limit = model ? contextLimitForModel(model) : 128_000
  return buildContextState(history, currentSystem(), limit, getCompactRatio())
}

function emitContext(): void {
  emit({ type: 'context', context: currentContext() })
}

function emitLoad(): void {
  emit({ type: 'load', load: modelLoad(getSettingsView().activeModel) })
}

function startLoadTicker(): void {
  if (loadTimer) return
  loadTimer = setInterval(emitLoad, 500)
  loadTimer.unref?.()
}

function stopLoadTicker(): void {
  if (!loadTimer) return
  clearInterval(loadTimer)
  loadTimer = null
}

interface NormalizedAttachments {
  files: ChatAttachment[]
  images: MessageImage[]
}

function normalizeAttachments(raw: unknown): NormalizedAttachments {
  if (raw === undefined) return { files: [], images: [] }
  if (!Array.isArray(raw)) throw new Error(tr('e.badAttachments'))
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(tr('e.tooManyAttachments', { n: MAX_ATTACHMENTS }))
  }

  const files: ChatAttachment[] = []
  const images: MessageImage[] = []
  let total = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) continue
    if (typeof candidate.content !== 'string' || !candidate.content.trim()) continue
    const name = candidate.name.trim().slice(0, 200)

    if (candidate.kind === 'image') {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/i.exec(
        candidate.content.trim()
      )
      if (!match) throw new Error(tr('e.imageBadData'))
      const data = match[2].replace(/\s+/g, '')
      const buffer = Buffer.from(data, 'base64')
      if (!buffer.length) throw new Error(tr('e.imageBadData'))
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error(tr('e.imageTooBig'))
      const mime = sniffImageMime(buffer)
      if (!mime || mime !== match[1].toLowerCase()) throw new Error(tr('e.imageBadData'))
      images.push({ name, mime, data })
      continue
    }

    if (candidate.content.includes('\u0000')) {
      throw new Error(tr('e.binaryFile', { name }))
    }
    if (candidate.content.length > MAX_ATTACHMENT_CHARS) {
      throw new Error(
        tr('e.fileTooBig', {
          name,
          n: Math.round(MAX_ATTACHMENT_CHARS / 1024)
        })
      )
    }
    total += candidate.content.length
    if (total > MAX_TOTAL_ATTACHMENT_CHARS) throw new Error(tr('e.totalTooBig'))
    files.push({
      name,
      size:
        typeof candidate.size === 'number' && candidate.size >= 0
          ? Math.round(candidate.size)
          : candidate.content.length,
      content: candidate.content
    })
  }
  return { files, images }
}

function buildUserContent(text: string, attachments: ChatAttachment[]): string {
  if (!attachments.length) return text
  const blocks = attachments.map(
    (attachment) =>
      `### ${tr('sys.attachment', { name: attachment.name, size: attachment.size })}\n${attachment.content}`
  )
  return `${text}\n\n${blocks.join('\n\n')}`
}

function cancelPendingApprovals(): void {
  for (const [id, resolve] of pendingApprovals) {
    resolve('deny')
    emit({ type: 'approval-resolved', id, approved: false })
  }
  pendingApprovals.clear()
}

function cancelPendingQuestions(): void {
  for (const [id, resolve] of pendingQuestions) {
    resolve('')
    emit({ type: 'question-resolved', id, answer: '' })
  }
  pendingQuestions.clear()
}

function isSyntheticTurn(text: string): boolean {
  return (
    text === tr('sys.trimmed') ||
    text === tr('sys.ackTrim') ||
    text === tr('sys.ackSummary') ||
    text.startsWith(tr('sys.summary'))
  )
}

function transcriptFromHistory(messages: ChatMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const message of messages) {
    if (message.role === 'tool') continue
    const text = message.content.trim()
    if (!text || isSyntheticTurn(text)) continue
    if (message.role === 'user') {
      entries.push({ role: 'user', content: message.content, images: message.images })
    } else if (message.role === 'assistant') {
      entries.push({ role: 'assistant', content: message.content })
    }
  }
  return entries
}

function loadProjectTranscript(projectPath: string | null): TranscriptEntry[] {
  if (privateSession || !projectPath) return []
  const stored = loadTranscript(projectPath)
  return stored ?? transcriptFromHistory(history)
}

function recordCompaction(event: AgentEvent): void {
  if (event.type === 'compact-end' && !privateSession) {
    transcript.push({ role: 'compaction', ok: event.ok, detail: event.detail })
  }
}

function appendAssistantTurns(messages: ChatMessage[]): void {
  if (privateSession) return
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (!message.content.trim()) continue
    transcript.push({ role: 'assistant', content: message.content })
  }
}

function appendUserTurn(content: string, images: MessageImage[]): void {
  if (privateSession) return
  transcript.push({ role: 'user', content, images: images.length ? images : undefined })
}

function switchProject(view: ReturnType<typeof getSettingsView>): void {
  history = privateSession ? [] : loadHistory(view.activeProjectPath)
  transcript = loadProjectTranscript(view.activeProjectPath)
  currentTitle = privateSession ? '' : loadTitle(view.activeProjectPath)
  emitContext()
}

function applyPendingProject(target: string): void {
  let view: ReturnType<typeof getSettingsView>
  try {
    view = setActiveProject(target)
  } catch {
    view = addProject(target)
  }
  switchProject(view)
  emit({
    type: 'project',
    path: target,
    name: view.projects.find((project) => project.path === target)?.name ?? path.basename(target)
  })
}

function restoredHistory(): RestoredMessage[] {
  const entries: RestoredMessage[] = []
  for (let index = 0; index < transcript.length; index++) {
    const entry = transcript[index]
    if (entry.role === 'compaction') {
      entries.push({
        id: `restored-${index}`,
        role: 'compaction',
        text: entry.detail,
        files: [],
        ok: entry.ok
      })
      continue
    }
    const text = entry.content.trim()
    if (!text) continue
    const cut = text.indexOf('\n\n### ')
    const body = cut < 0 ? text : text.slice(0, cut)
    const files = [...text.matchAll(/^### (.+?) \((\d+)[^)]*\)$/gm)].map((match) => ({
      name: match[1],
      size: Number(match[2])
    }))
    const images =
      entry.role === 'user'
        ? entry.images?.map((image, imageIndex) => ({
            name:
              image.name?.trim() ||
              `image-${imageIndex + 1}.${image.mime.replace(/^image\//, '') || 'png'}`,
            mime: image.mime,
            dataUrl: `data:${image.mime};base64,${image.data}`
          }))
        : undefined
    entries.push({
      id: `restored-${index}`,
      role: entry.role,
      text: body,
      files: entry.role === 'user' ? files : [],
      images: images?.length ? images : undefined
    })
  }
  return entries
}

function createWindow(): void {
  const settingsView = getSettingsView()
  const size = WINDOW_SIZES[settingsView.windowMode]
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    show: false,
    title: 'CloseCode',
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../resources/icon.png'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  mainWindow = window
  window.setBackgroundColor('#00000000')
  window.webContents.setZoomFactor(getUiScaleFactor())

  window.on('ready-to-show', () => {
    window.show()
    emitWindowState()
  })
  window.on('closed', () => {
    cancelPendingApprovals()
    runController?.abort()
    stopLoadTicker()
    stopShell()
    mainWindow = null
  })
  window.on('maximize', emitWindowState)
  window.on('unmaximize', emitWindowState)
  window.on('enter-full-screen', emitWindowState)
  window.on('leave-full-screen', emitWindowState)
  window.on('restore', emitWindowState)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const SENSITIVE_PATHS =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|electron\.vite\.config\.[^/]+|vite\.config\.[^/]+|\.env[^/]*|\.git\/|\.github\/|Dockerfile|docker-compose[^/]*|src\/main\/|src\/preload\/|scripts\/)/i

function isImportantChange(request: ApprovalRequest): boolean {
  if (request.scope !== 'write') return true
  if (request.oldContent === null) return true
  const path = request.path.replace(/\\/g, '/')
  if (SENSITIVE_PATHS.test(path)) return true
  const stats = diffStats(request.oldContent, request.newContent ?? '')
  return stats.added + stats.removed > 60
}

function autoApprovalFor(request: ApprovalRequest): ApprovalAnswer | null {
  const policy = getApprovalPolicy()
  if (policy === 'always') return null
  if (request.scope !== 'write' && request.scope !== 'image') return null
  if (policy === 'never') return 'once'
  return request.scope === 'write' && isImportantChange(request) ? null : 'once'
}

const OPINION_SYSTEM = `You are a meticulous second reviewer for a coding agent's answer.
Check the answer against the user's request: correctness, missed requirements, risky assumptions, broken edge cases, security and data-loss risks.
Reply in the language of the conversation. Be concrete and short: list real problems first, then one line on what is good. If the answer is sound, say so plainly.`

const OPINION_MAX_TOKENS = 8192

async function buildSecondOpinion(): Promise<SecondOpinionResult> {
  if (running) throw new Error(tr('e.running'))
  if (!history.length) throw new Error(tr('e.noOpinion'))
  const view = getSettingsView(history.length)
  const active = view.providers.find((provider) => provider.id === view.activeProviderId) ?? null
  const candidates = view.providers.filter((provider) =>
    provider.models.some((model) => !isImageModel(model))
  )
  if (!active && !candidates.length) throw new Error(tr('e.noProviderActive'))

  const other = candidates.find((provider) => provider.id !== active?.id) ?? null
  const chosen = view.opinionProviderId
    ? view.providers.find((provider) => provider.id === view.opinionProviderId) ?? null
    : null
  const reviewer = chosen ?? other ?? active ?? candidates[0]
  if (!reviewer) throw new Error(tr('e.noProviderActive'))
  const models = reviewer.models.filter((model) => !isImageModel(model))
  const preferred = chosen ? view.opinionModel : null
  const model =
    (preferred && preferred !== view.activeModel ? preferred : null) ??
    models.find((item) => item !== view.activeModel) ??
    models[0] ??
    ''
  if (!model) throw new Error(tr('e.noModel'))
  const provider = getAgentProvider(reviewer.id)
  if (!provider) throw new Error(tr('e.noProvider'))

  const user = [...history].reverse().find((message) => message.role === 'user')
  const assistant = [...history]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())
  if (!user || !assistant) throw new Error(tr('e.noOpinion'))

  const prompt = [
    'USER REQUEST:',
    user.content.slice(0, 9000),
    '',
    'AGENT ANSWER TO REVIEW:',
    assistant.content.slice(0, 16000)
  ].join('\n')

  const controller = new AbortController()
  running = true
  runController = controller
  startLoadTicker()
  const timer = setTimeout(() => controller.abort(), 150_000)
  timer.unref?.()
  const stream = provider.kind === 'anthropic' ? streamAnthropic : streamOpenAi
  try {
    const result = await stream(
      {
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model,
        system: OPINION_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        signal: controller.signal,
        maxTokens: OPINION_MAX_TOKENS,
        temperature: 0.2,
        reasoningEffort: reasoningEffortFor(model, 'low'),
        thinkingBudget: thinkingBudgetFor(model, 'low')
      },
      () => undefined
    )
    const text = result.text.trim()
    if (!text) throw new Error(tr('e.emptyResponse'))
    return { text, model, providerLabel: reviewer.label }
  } finally {
    clearTimeout(timer)
    running = false
    runController = null
    stopLoadTicker()
    emitContext()
    emitLoad()
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettingsView(history.length))

  ipcMain.handle('settings:save', (_event, payload: SaveSettingsPayload) => {
    const view = saveSettings(payload)
    emitContext()
    emitLoad()
    return view
  })

  ipcMain.handle('settings:set-active', (_event, payload: SetActiveModelPayload) => {
    if (!payload || typeof payload.providerId !== 'string' || typeof payload.model !== 'string') {
      throw new Error(tr('e.badModel'))
    }
    const view = setActiveModel(payload.providerId, payload.model)
    emitContext()
    emitLoad()
    return view
  })

  ipcMain.handle('settings:set-language', (_event, language: Lang) => {
    const view = setLanguageSetting(language === 'en' ? 'en' : 'ru')
    emitContext()
    return view
  })

  ipcMain.handle('settings:set-effort', (_event, effort: EffortLevel) =>
    setEffortSetting(normalizeEffort(effort))
  )

  ipcMain.handle('settings:set-appearance', (_event, payload: AppearancePayload) => {
    const before = getSettingsView()
    const view = setAppearanceSetting(payload)
    if (view.windowMode !== before.windowMode) applyWindowMode(view.windowMode)
    if (view.uiScale !== before.uiScale && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(view.uiScale / 100)
    }
    return view
  })

  ipcMain.handle('settings:set-second-opinion', (_event, payload: SecondOpinionPayload) =>
    setSecondOpinionSetting(payload)
  )

  ipcMain.handle('window:state', () => windowState())

  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return windowState()
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    emitWindowState()
    return windowState()
  })

  ipcMain.on('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:bounds', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    return mainWindow.getBounds()
  })

  ipcMain.on('window:resize', (_event, raw: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return
    if (!raw || typeof raw !== 'object') return
    const candidate = raw as Partial<WindowBounds>
    const values = [candidate.x, candidate.y, candidate.width, candidate.height]
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return
    const [minWidth, minHeight] = mainWindow.getMinimumSize()
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    const width = Math.max(minWidth, Math.min(Math.round(candidate.width as number), area.width))
    const height = Math.max(minHeight, Math.min(Math.round(candidate.height as number), area.height))
    const x = Math.max(
      area.x,
      Math.min(Math.round(candidate.x as number), area.x + area.width - width)
    )
    const y = Math.max(
      area.y,
      Math.min(Math.round(candidate.y as number), area.y + area.height - height)
    )
    mainWindow.setBounds({ x, y, width, height })
  })

  ipcMain.handle('terminal:start', (_event, options: unknown) => {
    const candidate = (options ?? {}) as { cols?: unknown; rows?: unknown }
    const cols = typeof candidate.cols === 'number' ? candidate.cols : 100
    const rows = typeof candidate.rows === 'number' ? candidate.rows : 30
    return startShell(cols, rows)
  })

  ipcMain.on('terminal:write', (_event, id: unknown, data: unknown) => {
    if (!terminal || terminal.id !== id || typeof data !== 'string') return
    terminal.pty.write(data)
  })

  ipcMain.on('terminal:resize', (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (!terminal || terminal.id !== id) return
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    const safeCols = Math.min(400, Math.max(20, Math.round(cols)))
    const safeRows = Math.min(200, Math.max(5, Math.round(rows)))
    try {
      terminal.pty.resize(safeCols, safeRows)
    } catch {
    }
  })

  ipcMain.on('terminal:stop', (_event, id: unknown) => {
    if (terminal && terminal.id === id) stopShell()
  })

  ipcMain.handle('settings:set-approval', (_event, policy: ApprovalPolicy) =>
    setApprovalPolicySetting(policy)
  )

  ipcMain.handle('settings:set-compact', (_event, percent: number) => {
    const view = setCompactAtSetting(Number(percent))
    emitContext()
    return view
  })

  ipcMain.handle('settings:fetch-models', async (_event, payload: FetchModelsPayload) => {
    if (!payload || (payload.kind !== 'openai' && payload.kind !== 'anthropic')) {
      throw new Error(tr('e.badProviderKind'))
    }
    const apiKey = resolveApiKeyForRequest(payload)
    const models = await fetchAvailableModels(payload.kind, payload.baseUrl, apiKey)
    return isFreeProvider({ id: payload.providerId ?? '', baseUrl: payload.baseUrl })
      ? filterFreeModels(models)
      : models
  })

  ipcMain.handle('project:add', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: tr('sys.selectProject'),
      buttonLabel: tr('sys.openProject'),
      properties: ['openDirectory'],
      defaultPath: getProjectPath() ?? app.getPath('home')
    })
    if (result.canceled || !result.filePaths[0]) return null
    switchProject(addProject(result.filePaths[0]))
    return getSettingsView(history.length)
  })

  ipcMain.handle('project:open', (_event, target: unknown) => {
    if (running) throw new Error(tr('e.stopFirst'))
    if (typeof target !== 'string' || !target) throw new Error(tr('s.projectsTitle'))
    switchProject(setActiveProject(target))
    return getSettingsView(history.length)
  })

  ipcMain.handle('project:remove', (_event, target: unknown) => {
    if (running) throw new Error(tr('e.stopFirst'))
    if (typeof target !== 'string' || !target) throw new Error(tr('s.projectsTitle'))
    switchProject(removeProject(target))
    return getSettingsView(history.length)
  })

  ipcMain.handle('access:revoke', (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) throw new Error(tr('s.accessTitle'))
    return revokeAllowedRoot(target)
  })

  ipcMain.handle('library:refresh', () => getSettingsView(history.length))

  ipcMain.handle('library:skill-enabled', (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string') throw new Error(tr('s.skillsTitle'))
    return setSkillEnabledSetting(id, enabled === true)
  })

  ipcMain.handle('library:open', (_event, kind: unknown) => {
    void shell.openPath(openLibraryDir(kind === 'agents' ? 'agents' : 'skills'))
  })

  ipcMain.handle('fs:tree', (_event, payload: TreePayload) => {
    const root = getProjectPath()
    if (!root) throw new Error(tr('e.noProjectFolder'))
    return projectTree(root, payload?.path)
  })

  ipcMain.handle('screen:capture', async (_event, display: unknown) => {
    const shot = await captureDisplay(typeof display === 'number' ? display : 0)
    if (shot.buffer.length > MAX_IMAGE_BYTES) throw new Error(tr('e.imageTooBig'))
    return {
      name: `screen-${Date.now().toString(36)}.png`,
      label: shot.label,
      mime: shot.mime,
      bytes: shot.buffer.length,
      dataUrl: `data:${shot.mime};base64,${shot.buffer.toString('base64')}`,
      width: shot.width,
      height: shot.height,
      displays: shot.displays
    }
  })

  ipcMain.handle('shell:reveal', (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) return
    const absolute = path.resolve(target)
    const roots = [getProjectPath(), ...getSettingsView().allowedRoots].filter(
      (root): root is string => typeof root === 'string' && !!root
    )
    if (!generatedImages.has(absolute) && !roots.some((root) => isPathUnder(root, absolute))) {
      return
    }
    shell.showItemInFolder(absolute)
  })

  ipcMain.handle('images:read', (_event, target: unknown) => {
    if (typeof target !== 'string' || !target.trim()) throw new Error(tr('e.imageNoData'))
    const absolute = path.resolve(target)
    const roots = [getProjectPath(), ...getSettingsView().allowedRoots].filter(
      (root): root is string => typeof root === 'string' && !!root
    )
    if (!generatedImages.has(absolute) && !roots.some((root) => isPathUnder(root, absolute))) {
      throw new Error(tr('e.noAccess'))
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(absolute)
    } catch {
      throw new Error(tr('e.imageNoData'))
    }
    if (!stat.isFile()) throw new Error(tr('e.notAFile', { path: absolute }))
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(tr('e.imageTooBig'))
    const buffer = fs.readFileSync(absolute)
    const mime = sniffImageMime(buffer)
    if (!mime) throw new Error(tr('e.imageBadData'))
    return `data:${mime};base64,${buffer.toString('base64')}`
  })

  ipcMain.handle('model:load', () => modelLoad(getSettingsView().activeModel))

  ipcMain.handle('chat:context', () => currentContext())

  ipcMain.handle('chat:history', () => restoredHistory())

  ipcMain.handle('chat:title', () => currentTitle)

  ipcMain.handle('chat:set-private', (_event, enabled: unknown) => {
    if (running) throw new Error(tr('e.stopFirst'))
    privateSession = enabled === true
    history = privateSession ? [] : loadHistory(getProjectPath())
    transcript = loadProjectTranscript(getProjectPath())
    currentTitle = privateSession ? '' : loadTitle(getProjectPath())
    emitContext()
    return privateSession
  })

  ipcMain.handle('chat:second-opinion', () => buildSecondOpinion())

  ipcMain.handle('chat:compact', async () => {
    if (running) throw new Error(tr('e.waitAction'))
    const view = getSettingsView(history.length)
    const provider =
      view.activeProviderId !== null ? getAgentProvider(view.activeProviderId) : null
    if (!provider || !view.activeModel) throw new Error(tr('e.noProviderActive'))
    if (!history.length) return currentContext()

    const controller = new AbortController()
    running = true
    runController = controller
    startLoadTicker()
    try {
      return await compactHistoryIfNeeded({
        messages: history,
        system: currentSystem(),
        provider: { kind: provider.kind, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
        model: view.activeModel,
        signal: controller.signal,
        emit: (event) => {
          recordCompaction(event)
          emit(event)
        },
        source: 'manual',
        effort: getEffort(),
        threshold: getCompactRatio(),
        force: true
      })
    } finally {
      running = false
      runController = null
      stopLoadTicker()
      if (!privateSession) saveHistory(getProjectPath(), history, transcript)
      emitContext()
    }
  })

  ipcMain.handle('chat:send', async (_event, payload: SendMessagePayload) => {
    if (running) throw new Error(tr('e.running'))
    if (!payload || typeof payload !== 'object') throw new Error(tr('e.emptyMessage'))
    const { files, images } = normalizeAttachments(payload.attachments)
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text && !files.length && !images.length) throw new Error(tr('e.emptyMessage'))
    const provider = getAgentProvider(
      typeof payload.providerId === 'string' ? payload.providerId : ''
    )
    if (!provider) throw new Error(tr('e.noProvider'))
    const model =
      (typeof payload.model === 'string' && payload.model.trim()) || provider.models[0] || ''
    if (!model) throw new Error(tr('e.noModel'))
    if (!provider.models.includes(model)) throw new Error(tr('e.modelNotListed'))

    const effort = normalizeEffort(payload.effort ?? getEffort())
    const projectPath = getProjectPath()
    const projects = getSettingsView()
      .projects.map((project) => ({ name: project.name, path: project.path }))
    const imageModels = provider.models.filter(isImageModel)
    const system = buildSystemPrompt({
      projectPath,
      effort,
      enabledSkills: getEnabledSkills(),
      imageModels,
      projects,
      screen: true
    })
    const fallback = images.length ? tr('sys.images') : tr('sys.attachments')
    const userContent = buildUserContent(text || fallback, files)
    const firstTurn = history.length === 0

    running = true
    const controller = new AbortController()
    runController = controller
    startLoadTicker()

    try {
      await compactHistoryIfNeeded({
        messages: history,
        system,
        provider: { kind: provider.kind, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
        model,
        signal: controller.signal,
        emit: (event) => {
          recordCompaction(event)
          emit(event)
        },
        source: 'auto',
        effort,
        threshold: getCompactRatio(),
        extraTokens: estimateTokens(userContent) + images.length * 1200
      })
    } catch (error) {
      running = false
      runController = null
      stopLoadTicker()
      if (!privateSession) saveHistory(getProjectPath(), history, transcript)
      if ((error as Error)?.name === 'AbortError') {
        emit({ type: 'done', cancelled: true })
        return
      }
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }

    if (controller.signal.aborted) {
      running = false
      runController = null
      stopLoadTicker()
      if (!privateSession) saveHistory(getProjectPath(), history, transcript)
      emit({ type: 'done', cancelled: true })
      return
    }

    appendUserTurn(userContent, images)
    history.push({
      role: 'user',
      content: userContent,
      images: images.length ? images : undefined
    })
    if (!privateSession) recordMessage()
    emitContext()
    emitLoad()
    if (firstTurn) {
      generateTaskTitle(
        text || [...files, ...images].map((attachment) => attachment.name ?? '').join(', '),
        provider,
        model,
        projectPath
      )
    }

    let pendingProject = ''
    let questionsLeft = MAX_QUESTIONS_PER_RUN

    void runAgent({
      provider: {
        kind: provider.kind,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        models: provider.models
      },
      model,
      system,
      messages: history,
      projectRoot: projectPath,
      signal: controller.signal,
      effort,
      compactThreshold: getCompactRatio(),
      projects,
      emit: (event) => {
        recordCompaction(event)
        emit(event)
      },
      image:
        projectPath && imageModels.length
          ? {
              models: imageModels,
              generate: async ({ model: imageModel, prompt, size }) => {
                const generated = await generateImage({
                  kind: provider.kind,
                  apiKey: provider.apiKey,
                  baseUrl: provider.baseUrl,
                  model: imageModel,
                  prompt,
                  size,
                  signal: controller.signal
                })
                return { buffer: generated.buffer, mime: generated.mime }
              }
            }
          : undefined,
      screen: {
        capture: async (display) => await captureDisplay(display),
        save: (buffer, display) => saveScreenshot(buffer, display)
      },
      onProgress: () => {
        emitContext()
        emitLoad()
      },
      onAssistantTurn: (message) => appendAssistantTurns([message]),
      onUserTurnAttached: (message) => {
        if (!privateSession) {
          transcript.push({
            role: 'user',
            content: message.content,
            images: message.role === 'user' ? message.images : undefined
          })
        }
      },
      onProjectSwitch: (target) => {
        pendingProject = target
      },
      onRotateAccount: async () => {
        const currentSettings = getSettingsView()
        const allProviders = currentSettings.providers.filter((p: ProviderView) => p.hasKey && p.models.length > 0)
        if (allProviders.length <= 1) return null
        const currentIndex = allProviders.findIndex((p: ProviderView) => p.id === currentSettings.activeProviderId)
        const nextIndex = (currentIndex + 1) % allProviders.length
        const nextProvider = allProviders[nextIndex]
        if (!nextProvider || nextProvider.id === currentSettings.activeProviderId) return null
        const nextModel = nextProvider.models[0] || model
        setActiveModel(nextProvider.id, nextModel)
        emitContext()
        emitLoad()
        const agentProv = getAgentProvider(nextProvider.id)
        if (!agentProv) return null
        return {
          switched: true,
          providerLabel: nextProvider.label,
          model: nextModel,
          provider: {
            kind: agentProv.kind,
            apiKey: agentProv.apiKey,
            baseUrl: agentProv.baseUrl,
            models: agentProv.models
          }
        }
      },
      grantRootFor: findGrantRoot,
      grant: (absolutePath) => addAllowedRoot(absolutePath),
      requestApproval: (request: ApprovalRequest) => {
        const automatic = autoApprovalFor(request)
        if (automatic) {
          emit({ type: 'approval-auto', path: request.path, scope: request.scope })
          return Promise.resolve(automatic)
        }
        return new Promise<ApprovalAnswer>((resolve) => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            resolve('deny')
            return
          }
          pendingApprovals.set(request.id, resolve)
          emit({ type: 'approval-request', request })
        })
      },
      requestQuestion: (question: UserQuestion) => {
        if (questionsLeft <= 0) return Promise.resolve('')
        questionsLeft -= 1
        return new Promise<string>((resolve) => {
          if (!mainWindow || mainWindow.isDestroyed()) {
            resolve('')
            return
          }
          pendingQuestions.set(question.id, resolve)
          emit({ type: 'question', question })
        })
      }
    })
      .then(() => emit({ type: 'done' }))
      .catch((error: unknown) => {
        if ((error as Error)?.name === 'AbortError') {
          emit({ type: 'done', cancelled: true })
          return
        }
        const lastMsg = history[history.length - 1]
        if (lastMsg && lastMsg.role === 'user') {
          const errMsg = error instanceof Error ? error.message : String(error)
          const fallbackAssistant: ChatMessage = {
            role: 'assistant',
            content: `${tr('e.providerError')}: ${errMsg}`
          }
          history.push(fallbackAssistant)
          appendAssistantTurns([fallbackAssistant])
        }
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        running = false
        runController = null
        stopLoadTicker()
        cancelPendingApprovals()
        cancelPendingQuestions()
        if (!privateSession) saveHistory(getProjectPath(), history, transcript)
        const next = pendingProject
        pendingProject = ''
        if (next) applyPendingProject(next)
        emitContext()
        emitLoad()
      })
  })

  ipcMain.handle('chat:cancel', () => {
    if (!running) return
    runController?.abort()
    cancelPendingApprovals()
    cancelPendingQuestions()
  })

  ipcMain.handle('chat:reset', () => {
    if (running) throw new Error(tr('e.stopFirst'))
    history = []
    transcript = []
    currentTitle = ''
    if (!privateSession) clearHistory(getProjectPath())
    emitContext()
  })

  ipcMain.handle('chat:export-json', async (_event, defaultName?: unknown) => {
    if (!mainWindow) return null
    const filename = typeof defaultName === 'string' && defaultName.trim()
      ? defaultName.trim()
      : `closecode-${Date.now().toString(36)}.json`
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    const data = {
      project: getProjectPath(),
      exportedAt: new Date().toISOString(),
      messages: history,
      transcript
    }
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8')
    return result.filePath
  })

  ipcMain.handle('chat:export', async (_event, payload: ExportChatPayload) => {
    if (!payload || typeof payload.markdown !== 'string') throw new Error(tr('e.emptyMessage'))
    if (!mainWindow) return null
    const defaultName =
      typeof payload.defaultName === 'string' && payload.defaultName.trim()
        ? payload.defaultName.trim()
        : 'closecode-chat.md'
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, payload.markdown, 'utf8')
    return result.filePath
  })

  ipcMain.handle('approval:respond', (_event, id: unknown, answer: unknown) => {
    if (typeof id !== 'string') return
    const resolve = pendingApprovals.get(id)
    if (!resolve) return
    pendingApprovals.delete(id)
    const accepted: ApprovalAnswer =
      answer === 'always' ? 'always' : answer === 'once' ? 'once' : 'deny'
    resolve(accepted)
    emit({ type: 'approval-resolved', id, approved: accepted !== 'deny' })
  })

  ipcMain.handle('question:respond', (_event, id: unknown, answer: unknown) => {
    if (typeof id !== 'string') return
    const resolve = pendingQuestions.get(id)
    if (!resolve) return
    pendingQuestions.delete(id)
    const text = typeof answer === 'string' ? answer.trim() : ''
    resolve(text)
    emit({ type: 'question-resolved', id, answer: text })
  })

  ipcMain.handle('activity:get', () => getActivity())

  ipcMain.handle('unlocker:status', () => getUnlockerStatus())
  ipcMain.handle('unlocker:set-enabled', (_event, enabled: unknown) => {
    setUnlockerEnabled(Boolean(enabled))
    return getUnlockerStatus()
  })
  ipcMain.handle('unlocker:import-google', async () => {
    const s = await importGoogleAntigravityProvider()
    emitContext()
    emitLoad()
    return s
  })
  ipcMain.handle('remote-control:status', () => ({
    running: remoteControl.isRunning(),
    port: remoteControl.getPort()
  }))
  ipcMain.handle('remote-control:set', async (_event, enabled: unknown, port?: unknown) => {
    if (enabled) {
      const p = await remoteControl.start(Number(port) || 4242)
      return { running: true, port: p }
    } else {
      await remoteControl.stop()
      return { running: false, port: 4242 }
    }
  })
}

const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.closecode.app')
    applyUnlockerProxy()
    if (session?.defaultSession) {
      session.defaultSession.setProxy({
        proxyRules: 'http://127.0.0.1:53129',
        proxyBypassRules: 'localhost,127.0.0.1'
      }).catch(() => {})
    }
    if (process.argv.includes('--remote-control')) {
      void remoteControl.start(4242)
    }
    remoteControl.setHandlers({
      onPrompt: async (text) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('remote:prompt', { prompt: text })
        }
      },
      onStop: () => {
        if (runController) {
          runController.abort()
          runController = null
        }
      },
      getState: () => ({
        activeModel: getSettingsView().activeModel,
        activeProject: getSettingsView().activeProjectPath,
        running
      }),
      getHistory: () => history
    })
    registerIpc()
    history = loadHistory(getProjectPath())
    transcript = loadProjectTranscript(getProjectPath())
    currentTitle = loadTitle(getProjectPath())
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    stopShell()
    if (!privateSession) saveHistory(getProjectPath(), history, transcript)
    flushActivity()
  })
}
