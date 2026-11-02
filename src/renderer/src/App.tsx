import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ActivityView,
  ApprovalAnswer,
  ApprovalRequest,
  ChatAttachment,
  ContextState,
  EffortLevel,
  ModelLoad,
  RestoredMessage,
  SettingsView,
  UserQuestion,
  WindowMode
} from '../../shared/types'
import { presentModel } from '../../shared/modelNames'
import { ApprovalModal } from './components/ApprovalModal'
import { SettingsScreen } from './components/SettingsScreen'
import { Composer } from './components/Composer'
import { Welcome } from './components/Welcome'
import { Sidebar } from './components/Sidebar'
import { ChatLog } from './components/ChatLog'
import { SecondOpinion, type OpinionState } from './components/SecondOpinion'
import { ProjectTree } from './components/ProjectTree'
import { QuestionCard } from './components/QuestionCard'
import { ProviderLogo, brandForProvider } from './components/ProviderLogo'
import { WindowControls, WindowResizeHandles } from './components/WindowChrome'
import { TerminalView } from './components/TerminalView'
import { UnlockerModal } from './components/UnlockerModal'
import {
  AlertIcon,
  ExpandIcon,
  FolderIcon,
  LayersIcon,
  LockIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  TerminalIcon,
  XIcon
} from './components/Icons'
import { deriveTaskTitle, overviewOf, type ChatItem, type RunStats } from './chat'
import { setRendererLang, useT } from './i18n'
import { errorText, newId } from './utils'

const MAX_FILES = 5
const MAX_FILE_BYTES = 200 * 1024
const MAX_FILE_CHARS = 200_000
const MAX_TOTAL_CHARS = 500_000
const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_DATA_CHARS = 8 * 1024 * 1024
const IMAGE_MAX_EDGE = 1600
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/i
const NON_TEXT_FILE =
  /^(image|video|audio|font)\/|application\/(pdf|zip|x-zip|x-7z|x-rar|octet-stream|msword|vnd)/

async function prepareImage(file: File): Promise<{ dataUrl: string; mime: string }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    const keepAlpha = file.type === 'image/png' && file.size <= 1_200_000
    if (!keepAlpha) {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)
    const mime = keepAlpha ? 'image/png' : 'image/jpeg'
    return { dataUrl: canvas.toDataURL(mime, 0.86), mime }
  } finally {
    bitmap.close()
  }
}

const EMPTY_SETTINGS: SettingsView = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  projects: [],
  projectPath: null,
  activeProjectPath: null,
  allowedRoots: [],
  language: 'ru',
  effort: 'medium',
  efforts: {},
  theme: 'graphite',
  accent: 'graphite',
  density: 'comfy',
  windowMode: 'app',
  motion: 'full',
  uiScale: 100,
  opinionProviderId: null,
  opinionModel: null,
  approvalPolicy: 'always',
  compactAt: 80,
  compactMin: 15,
  compactMax: 95,
  skills: [],
  agents: []
}

function emptyRun(): RunStats {
  return { steps: 0, done: 0, failed: 0, files: {} }
}

function finishCompaction(
  items: ChatItem[],
  status: 'ok' | 'error',
  detail: string
): ChatItem[] {
  let index = -1
  for (let cursor = items.length - 1; cursor >= 0; cursor--) {
    const item = items[cursor]
    if (item.kind === 'compaction' && item.status === 'running') {
      index = cursor
      break
    }
  }
  if (index < 0) return items
  return items.map((item, cursor) =>
    cursor === index && item.kind === 'compaction' ? { ...item, status, detail } : item
  )
}

function toChatItems(messages: RestoredMessage[]): ChatItem[] {
  return messages.map((message) => {
    if (message.role === 'compaction') {
      return {
        kind: 'compaction',
        id: `restored-${message.id}`,
        status: message.ok === false ? 'error' : 'ok',
        detail: message.text
      }
    }
    return message.role === 'user'
      ? {
          kind: 'user',
          id: `restored-${message.id}`,
          text: message.text,
          files: message.files,
          images: message.images?.map((image) => ({ name: image.name, src: image.dataUrl }))
        }
      : { kind: 'assistant', id: `restored-${message.id}`, text: message.text }
  })
}

export default function App(): ReactNode {
  const { t, lang } = useT()
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [context, setContext] = useState<ContextState | null>(null)
  const [activity, setActivity] = useState<ActivityView | null>(null)
  const [load, setLoad] = useState<ModelLoad | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [streaming, setStreaming] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [unlockerOpen, setUnlockerOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [question, setQuestion] = useState<UserQuestion | null>(null)
  const [toast, setToast] = useState('')
  const [effort, setEffort] = useState<EffortLevel>('medium')
  const [title, setTitle] = useState('')
  const [privateSession, setPrivateSession] = useState(false)
  const [runStats, setRunStats] = useState<RunStats | null>(null)
  const [opinion, setOpinion] = useState<OpinionState | null>(null)
  const [terminalTab, setTerminalTab] = useState<'agent' | 'shell'>('shell')
  const [appShellOpen, setAppShellOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'u' || event.key === 'U')) {
        event.preventDefault()
        setUnlockerOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

  const activeProvider =
    settings?.providers.find((provider) => provider.id === settings.activeProviderId) ?? null
  const activeModel = settings?.activeModel ?? ''
  const projectName =
    settings?.projects.find((project) => project.path === settings.activeProjectPath)?.name ?? ''
  const agentReady = Boolean(activeProvider && activeModel)
  const busy = streaming || compacting
  const taskTitle = title || (items.length ? deriveTaskTitle(items) : '')
  const terminal = settings?.windowMode === 'terminal'
  const shellOpen = terminal ? terminalTab === 'shell' : appShellOpen
  const runOverview = useMemo(() => (runStats ? overviewOf(runStats) : null), [runStats])

  const applyView = useCallback((view: SettingsView): void => {
    setRendererLang(view.language)
    setSettings(view)
    setEffort(view.effort)
  }, [])

  const refreshContext = useCallback(async (): Promise<void> => {
    try {
      setContext(await window.closecode.getContext())
    } catch {
    }
  }, [])

  const hydrateProject = useCallback(async (): Promise<void> => {
    atBottomRef.current = true
    try {
      const [history, state, storedTitle] = await Promise.all([
        window.closecode.getHistory(),
        window.closecode.getContext(),
        window.closecode.getTaskTitle()
      ])
      setItems(toChatItems(history))
      setContext(state)
      setTitle(storedTitle)
    } catch {
      setItems([])
      setTitle('')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.closecode
      .getSettings()
      .then((view) => {
        if (cancelled) return
        applyView(view)
        if (!view.providers.length) setSettingsOpen(true)
        void hydrateProject()
        window.closecode
          .getModelLoad()
          .then((value) => {
            if (!cancelled) setLoad(value)
          })
          .catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setToast(errorText(error))
        setRendererLang(EMPTY_SETTINGS.language)
        setSettings(EMPTY_SETTINGS)
      })
    return () => {
      cancelled = true
    }
  }, [applyView, hydrateProject])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = settings?.theme ?? 'graphite'
    root.dataset.accent = settings?.accent ?? 'graphite'
    root.dataset.density = settings?.density ?? 'comfy'
    root.dataset.mode = settings?.windowMode ?? 'app'
    root.dataset.motion = settings?.motion ?? 'full'
  }, [
    settings?.theme,
    settings?.accent,
    settings?.density,
    settings?.windowMode,
    settings?.motion
  ])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 7000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (busy) return
    let cancelled = false
    const fetchActivity = (): void => {
      window.closecode
        .getActivity()
        .then((view) => {
          if (!cancelled) setActivity(view)
        })
        .catch(() => undefined)
    }
    fetchActivity()
    const timer = window.setTimeout(fetchActivity, 1500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [busy, items.length, privateSession])

  useEffect(() => {
    const unsubscribe = window.closecode.onAgentEvent((event) => {
      switch (event.type) {
        case 'text-delta':
          if (!event.text) break
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'assistant') {
              return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [...prev, { kind: 'assistant', id: newId(), text: event.text }]
          })
          break
        case 'tool-start': {
          const path =
            typeof event.args.path === 'string'
              ? event.args.path
              : event.name === 'list_files'
                ? '.'
                : null
          if (!event.parent) {
            setRunStats((prev) => {
              const base = prev ?? emptyRun()
              return { ...base, steps: base.steps + 1 }
            })
          }
          setItems((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: event.id,
              name: event.name,
              path,
              status: 'running',
              detail: '',
              startedAt: Date.now(),
              parent: event.parent ?? null,
              agent: event.agent ?? null
            }
          ])
          break
        }
        case 'tool-end':
          if (!event.parent) {
            setRunStats((prev) => {
              const base = prev ?? emptyRun()
              return {
                ...base,
                done: base.done + 1,
                failed: base.failed + (event.ok ? 0 : 1)
              }
            })
          }
          setItems((prev) =>
            prev.map((item) =>
              item.kind === 'tool' && item.id === event.id
                ? {
                    ...item,
                    status: event.ok ? 'ok' : 'error',
                    detail: event.detail,
                    finishedAt: Date.now()
                  }
                : item
            )
          )
          break
        case 'edit':
          setRunStats((prev) => {
            const base = prev ?? emptyRun()
            return {
              ...base,
              files: {
                ...base.files,
                [event.path]: { added: event.added, removed: event.removed }
              }
            }
          })
          break
        case 'image':
          setItems((prev) => [
            ...prev.map((item) =>
              item.kind === 'tool' && item.id === event.id && item.name === 'generate_image'
                ? { ...item, path: event.path }
                : item
            ),
            {
              kind: 'image',
              id: `image-${event.id}`,
              path: event.path,
              absolutePath: event.absolutePath,
              mime: event.mime,
              bytes: event.bytes
            }
          ])
          break
        case 'title':
          setTitle(event.title)
          break
        case 'project':
          window.closecode
            .getSettings()
            .then(applyView)
            .catch(() => undefined)
          void hydrateProject().then(() => {
            setItems((prev) => [
              ...prev,
              { kind: 'notice', id: newId(), text: t('chat.projectOpened', { name: event.name }) }
            ])
          })
          break
        case 'approval-request':
          setApproval(event.request)
          break
        case 'approval-resolved':
          setApproval((current) => (current && current.id === event.id ? null : current))
          break
        case 'question':
          setQuestion(event.question)
          break
        case 'question-resolved':
          setQuestion((current) => (current && current.id === event.id ? null : current))
          break
        case 'context':
          setContext(event.context)
          break
        case 'load':
          setLoad(event.load)
          break
        case 'compact-start':
          setCompacting(true)
          setItems((prev) => [
            ...prev,
            {
              kind: 'compaction',
              id: newId(),
              status: 'running',
              detail: t(event.source === 'auto' ? 'chat.compactAuto' : 'chat.compactManual')
            }
          ])
          break
        case 'compact-end':
          setCompacting(false)
          if (event.context) setContext(event.context)
          setItems((prev) => finishCompaction(prev, event.ok ? 'ok' : 'error', event.detail))
          break
        case 'done':
          setStreaming(false)
          setCompacting(false)
          setApproval(null)
          setQuestion(null)
          window.closecode
            .getSettings()
            .then(applyView)
            .catch(() => undefined)
          setItems((prev) => {
            const next = finishCompaction(prev, 'error', t('d.stopped'))
            if (!event.cancelled) return next
            return [...next, { kind: 'notice', id: newId(), text: t('chat.stopped') }]
          })
          break
        case 'error':
          setStreaming(false)
          setCompacting(false)
          setApproval(null)
          setQuestion(null)
          setItems((prev) => [
            ...finishCompaction(prev, 'error', t('d.interrupted')),
            { kind: 'error', id: newId(), text: event.message }
          ])
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [lang, applyView, hydrateProject])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (!items.length) {
      element.scrollTop = 0
      atBottomRef.current = true
      return
    }
    if (atBottomRef.current) element.scrollTop = element.scrollHeight
  }, [items, approval, compacting])

  function onChatScroll(): void {
    const element = scrollRef.current
    if (!element) return
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
  }

  function send(text: string, files: ChatAttachment[]): void {
    if (!settings || !activeProvider) {
      setSettingsOpen(true)
      return
    }
    atBottomRef.current = true
    setRunStats(emptyRun())
    const photos = files.filter((file) => file.kind === 'image')
    setItems((prev) => [
      ...prev,
      {
        kind: 'user',
        id: newId(),
        text: text || t(photos.length ? 'chat.imageOnly' : 'chat.attachmentOnly'),
        files: files
          .filter((file) => file.kind !== 'image')
          .map((file) => ({ name: file.name, size: file.size })),
        images: photos.length
          ? photos.map((file) => ({ name: file.name, src: file.content }))
          : undefined
      }
    ])
    setStreaming(true)
    void window.closecode
      .sendMessage({
        text,
        providerId: activeProvider.id,
        model: activeModel,
        effort,
        attachments: files.length ? files : undefined
      })
      .catch((error: unknown) => {
        setStreaming(false)
        setCompacting(false)
        setItems((prev) => [...prev, { kind: 'error', id: newId(), text: errorText(error) }])
      })
  }

  function submit(): void {
    const text = input.trim()
    if ((!text && !attachments.length) || busy || !settings) return
    if (!activeProvider || !activeModel) {
      setSettingsOpen(true)
      return
    }
    setInput('')
    setAttachments([])
    send(text, attachments)
  }

  function stop(): void {
    void window.closecode.cancel().catch((error: unknown) => setToast(errorText(error)))
  }

  async function newChat(): Promise<void> {
    if (busy) return
    try {
      await window.closecode.resetChat()
      setItems([])
      setTitle('')
      setRunStats(null)
      setApproval(null)
      setToast('')
      setAttachments([])
      await refreshContext()
      textareaRef.current?.focus()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function addProject(): Promise<void> {
    if (busy) return
    try {
      const view = await window.closecode.addProject()
      if (!view) return
      applyView(view)
      setAttachments([])
      setRunStats(null)
      await hydrateProject()
      textareaRef.current?.focus()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function openProject(path: string): Promise<void> {
    if (busy) {
      setToast(t('e.stopFirst'))
      return
    }
    try {
      applyView(await window.closecode.openProject(path))
      setAttachments([])
      setRunStats(null)
      await hydrateProject()
      textareaRef.current?.focus()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function removeProject(path: string): Promise<void> {
    if (busy) {
      setToast(t('e.stopFirst'))
      return
    }
    try {
      applyView(await window.closecode.removeProject(path))
      setRunStats(null)
      await hydrateProject()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function changeModel(providerId: string, model: string): Promise<void> {
    try {
      applyView(await window.closecode.setActiveModel({ providerId, model }))
      await refreshContext()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function changeEffort(level: EffortLevel): Promise<void> {
    setEffort(level)
    try {
      applyView(await window.closecode.setEffort(level))
    } catch {
    }
  }

  async function changeWindowMode(mode: WindowMode): Promise<void> {
    if (!settings) return
    try {
      applyView(
        await window.closecode.setAppearance({
          theme: settings.theme,
          accent: settings.accent,
          density: settings.density,
          windowMode: mode,
          motion: settings.motion,
          uiScale: settings.uiScale
        })
      )
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function togglePrivate(): Promise<void> {
    if (busy) {
      setToast(t('e.stopFirst'))
      return
    }
    try {
      const enabled = await window.closecode.setPrivateSession(!privateSession)
      setPrivateSession(enabled)
      setRunStats(null)
      setApproval(null)
      setAttachments([])
      await hydrateProject()
      textareaRef.current?.focus()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  async function askOpinion(): Promise<void> {
    if (opinion?.loading || busy) return
    setOpinion({ loading: true })
    try {
      const result = await window.closecode.secondOpinion()
      setOpinion({ loading: false, result })
    } catch (error) {
      setOpinion({ loading: false, error: errorText(error) })
    }
  }

  async function compactContextNow(): Promise<void> {
    if (busy || !items.length) return
    setCompacting(true)
    try {
      setContext(await window.closecode.compactContext())
    } catch (error) {
      setToast(errorText(error))
    } finally {
      setCompacting(false)
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    if (!files.length) return
    const next = [...attachments]
    let total = next.reduce(
      (sum, file) => sum + (file.kind === 'image' ? 0 : file.content.length),
      0
    )
    let added = 0

    for (const file of files) {
      if (next.length >= MAX_FILES) {
        setToast(t('e.tooManyAttachments', { n: MAX_FILES }))
        break
      }
      if (next.some((item) => item.name === file.name && item.size === file.size)) continue
      if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
        if (!IMAGE_TYPES.test(file.type)) {
          setToast(t('e.imageFormat', { name: file.name }))
          continue
        }
        if (file.size > MAX_IMAGE_SOURCE_BYTES) {
          setToast(t('e.imageAttachBig', { name: file.name }))
          continue
        }
        try {
          const prepared = await prepareImage(file)
          if (prepared.dataUrl.length > MAX_IMAGE_DATA_CHARS) {
            setToast(t('e.imageAttachBig', { name: file.name }))
            continue
          }
          next.push({
            name: file.name || `image-${Date.now()}.${prepared.mime.split('/')[1]}`,
            size: file.size,
            content: prepared.dataUrl,
            kind: 'image',
            mime: prepared.mime
          })
          added += 1
        } catch {
          setToast(t('e.imageRead', { name: file.name }))
        }
        continue
      }
      if (file.type && file.type !== 'image/svg+xml' && NON_TEXT_FILE.test(file.type)) {
        setToast(t('e.notText', { name: file.name }))
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        setToast(t('e.fileTooBig', { name: file.name, n: Math.round(MAX_FILE_BYTES / 1024) }))
        continue
      }
      let content = ''
      try {
        content = await file.text()
      } catch {
        setToast(t('e.readFail', { name: file.name }))
        continue
      }
      if (content.includes('\u0000')) {
        setToast(t('e.binaryFile', { name: file.name }))
        continue
      }
      if (content.length > MAX_FILE_CHARS) {
        setToast(t('e.tooBigContext', { name: file.name }))
        continue
      }
      if (total + content.length > MAX_TOTAL_CHARS) {
        setToast(t('e.totalTooBig'))
        break
      }
      next.push({ name: file.name, size: file.size, content })
      total += content.length
      added += 1
    }

    if (added) {
      setAttachments(next)
      textareaRef.current?.focus()
    }
  }

  async function attachScreenshot(): Promise<void> {
    if (attachments.length >= MAX_FILES) {
      setToast(t('e.tooManyAttachments', { n: MAX_FILES }))
      return
    }
    try {
      const shot = await window.closecode.captureScreen(1)
      if (shot.dataUrl.length > MAX_IMAGE_DATA_CHARS) {
        setToast(t('e.imageAttachBig', { name: shot.name }))
        return
      }
      setAttachments((prev) => [
        ...prev,
        { name: shot.name, size: shot.bytes, content: shot.dataUrl, kind: 'image', mime: shot.mime }
      ])
      textareaRef.current?.focus()
    } catch (error) {
      setToast(errorText(error))
    }
  }

  function removeAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, cursor) => cursor !== index))
  }

  function respondApproval(answer: ApprovalAnswer): void {
    const request = approval
    if (!request) return
    setApproval(null)
    void window.closecode
      .respondApproval(request.id, answer)
      .then(async () => {
        if (answer === 'always') applyView(await window.closecode.getSettings())
      })
      .catch((error: unknown) => setToast(errorText(error)))
  }

  function answerQuestion(answer: string): void {
    const current = question
    if (!current) return
    setQuestion(null)
    void window.closecode
      .answerQuestion(current.id, answer)
      .then(() =>
        setItems((prev) => [
          ...prev,
          {
            kind: 'notice',
            id: newId(),
            text: answer ? t('chat.answered', { answer }) : t('chat.questionSkipped')
          }
        ])
      )
      .catch((error: unknown) => setToast(errorText(error)))
  }

  if (!settings) {
    return (
      <div className="boot">
        <span className="boot-prompt" aria-hidden="true">
          <span>❯</span>
          <i />
        </span>
        <span>{t('chrome.loading')}</span>
      </div>
    )
  }

  const treeToggle = settings.activeProjectPath ? (
    <button
      type="button"
      className={`icon-btn${treeOpen ? ' active' : ''}`}
      title={t('chrome.tree')}
      aria-label={t('chrome.tree')}
      aria-pressed={treeOpen}
      onClick={() => setTreeOpen((value) => !value)}
    >
      <LayersIcon size={15} />
    </button>
  ) : null

  return (
    <div className={`app${terminal ? ' mode-terminal' : ''}`} data-mode={settings.windowMode}>
      {terminal ? (
        <header className="app-chrome terminal-chrome">
          <div className="term-tabs" role="tablist" aria-label={t('term.tabShell')}>
            <button
              type="button"
              role="tab"
              aria-selected={terminalTab === 'agent'}
              className={`term-tab${terminalTab === 'agent' ? ' active' : ''}`}
              onClick={() => setTerminalTab('agent')}
            >
              {t('term.tabAgent')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={terminalTab === 'shell'}
              className={`term-tab${terminalTab === 'shell' ? ' active' : ''}`}
              onClick={() => setTerminalTab('shell')}
            >
              {t('term.tabShell')}
            </button>
          </div>
          <button
            type="button"
            className="term-project"
            onClick={() => void addProject()}
            disabled={busy}
            title={settings.activeProjectPath ?? t('side.addProject')}
          >
            <FolderIcon size={11} />
            <span>{projectName || t('side.addProject')}</span>
          </button>
          {terminalTab === 'agent' && (
            <span className="term-title">{taskTitle || t('side.taskIdle')}</span>
          )}
          <span className={`term-live${busy ? ' busy' : ''}`} aria-hidden="true" />
          <span className="chrome-drag" aria-hidden="true" />
          <div className="chrome-actions">
            <button
              type="button"
              className="icon-btn"
              title={t('side.newTask')}
              aria-label={t('side.newTask')}
              onClick={() => void newChat()}
              disabled={busy}
            >
              <PlusIcon size={15} />
            </button>
            {treeToggle}
            <button
              type="button"
              className="icon-btn"
              title={t('chrome.settings')}
              aria-label={t('chrome.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t('term.openApp')}
              aria-label={t('term.openApp')}
              onClick={() => void changeWindowMode('app')}
            >
              <ExpandIcon size={15} />
            </button>
          </div>
          <WindowControls />
        </header>
      ) : (
        <header className="app-chrome">
          <div className="chrome-context">
            <span className="chrome-context-project">
              <FolderIcon size={12} />
              {projectName || t('side.noProject')}
            </span>
            {taskTitle && (
              <>
                <span className="chrome-context-sep" aria-hidden="true">
                  /
                </span>
                <span className="chrome-context-task" title={taskTitle}>
                  {taskTitle}
                </span>
              </>
            )}
          </div>

          <div className="chrome-drag" aria-hidden="true" />

          <div className="chrome-actions">
            <button
              type="button"
              className={`icon-btn${appShellOpen ? ' active' : ''}`}
              title={appShellOpen ? t('term.tabAgent') : t('term.shellOpen')}
              aria-label={t('term.shellOpen')}
              aria-pressed={appShellOpen}
              onClick={() => setAppShellOpen((value) => !value)}
            >
              <TerminalIcon size={16} />
            </button>
            {treeToggle}
            {settings.providers.length > 0 ? (
              <button
                type="button"
                className="provider-cluster"
                onClick={() => setSettingsOpen(true)}
                title={t('side.providerKeys')}
              >
                <span className="provider-cluster-logos">
                  {settings.providers.slice(0, 3).map((provider) => (
                    <ProviderLogo
                      key={provider.id}
                      brand={brandForProvider(provider)}
                      size={24}
                      className="cluster-logo"
                    />
                  ))}
                </span>
                <span className="provider-cluster-label">
                  {t('chrome.api', { n: settings.providers.length })}
                </span>
              </button>
            ) : (
              <button type="button" className="add-key-btn" onClick={() => setSettingsOpen(true)}>
                <LockIcon size={13} />
                {t('chrome.apiKey')}
              </button>
            )}

            <button
              type="button"
              className="icon-btn"
              title="AgyUnlocker & Antigravity (Ctrl+U)"
              aria-label="AgyUnlocker & Antigravity"
              onClick={() => setUnlockerOpen(true)}
            >
              <ShieldIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t('chrome.settings')}
              aria-label={t('chrome.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={16} />
            </button>
          </div>
          <WindowControls />
        </header>
      )}

      <div className="app-body">
        {!terminal && (
          <Sidebar
            settings={settings}
            taskTitle={taskTitle}
            activity={activity}
            streaming={streaming}
            compacting={compacting}
            ready={agentReady}
            privateSession={privateSession}
            onNewTask={() => void newChat()}
            onAddProject={() => void addProject()}
            onOpenProject={(path) => void openProject(path)}
            onRemoveProject={(path) => void removeProject(path)}
            onTogglePrivate={() => void togglePrivate()}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        <main className="workspace">
          {shellOpen ? (
            <TerminalView
              active
              compact={terminal}
              cwd={settings.activeProjectPath}
              onClose={terminal ? undefined : () => setAppShellOpen(false)}
            />
          ) : (
            <>
          <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
            <div className={`chat-inner${items.length ? ' has-log' : ''}`}>
              {items.length === 0 ? (
                terminal ? (
                  <div className="term-welcome">
                    <div className="term-banner">
                      <div className="term-banner-head">
                        <span className="term-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="term-banner-title">{t('term.tabAgent')}</span>
                        <span className="term-banner-mode">mini</span>
                      </div>
                      <div className="term-banner-body">
                        <div className="term-line term-ready">
                          <span className="term-prompt">❯</span>
                          <span>{t('term.ready')}</span>
                          <span className="term-caret" aria-hidden="true" />
                        </div>
                        <div className="term-meta">
                          <span className="term-meta-key">{t('term.model')}</span>
                          <span className="term-meta-val">
                            {settings.activeModel
                              ? presentModel(
                                  settings.activeModel,
                                  activeProvider?.label,
                                  activeProvider?.baseUrl
                                ).display
                              : t('term.connect')}
                          </span>
                        </div>
                        <div className="term-meta">
                          <span className="term-meta-key">{t('term.project')}</span>
                          <button
                            type="button"
                            className="term-link"
                            onClick={() => void addProject()}
                            disabled={busy}
                          >
                            {projectName || t('term.noProject')}
                          </button>
                        </div>
                      </div>
                      <div className="term-keys">
                        <span className="term-key">
                          <kbd>↵</kbd>
                          {t('term.keySend')}
                        </span>
                        <span className="term-key">
                          <kbd>⇧ ↵</kbd>
                          {t('term.keyNewline')}
                        </span>
                      </div>
                    </div>
                    <p className="term-hint">{t('term.settingsHint')}</p>
                  </div>
                ) : (
                  <Welcome
                    settings={settings}
                    ready={agentReady}
                    context={context}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenUnlocker={() => setUnlockerOpen(true)}
                    onImportGoogle={async () => {
                      try {
                        await window.closecode.importAntigravityGoogle()
                        await hydrateProject()
                        setToast('Google Gemini Pro/Ultra успешно подключён из Antigravity!')
                      } catch (err) {
                        setToast(`Ошибка импорта: ${errorText(err)}`)
                      }
                    }}
                    onAddDeepSeek={() => {
                      setSettingsOpen(true)
                    }}
                  />
                )
              ) : (
                <ChatLog items={items} streaming={streaming} compacting={compacting} />
              )}
            </div>
          </div>

          {question && <QuestionCard question={question} onAnswer={answerQuestion} />}
          <Composer
            settings={settings}
            input={input}
            onInputChange={setInput}
            onSend={submit}
            onStop={stop}
            streaming={streaming}
            compacting={compacting}
            effort={effort}
            onEffortChange={(level) => void changeEffort(level)}
            load={load}
            attachments={attachments}
            onAddFiles={(files) => void addFiles(files)}
            onCaptureScreen={() => void attachScreenshot()}
            onRemoveAttachment={removeAttachment}
            context={context}
            canCompact={items.length > 0}
            onCompact={() => void compactContextNow()}
            onSelectModel={(providerId, model) => void changeModel(providerId, model)}
            onAddProject={() => void addProject()}
            onOpenSettings={() => setSettingsOpen(true)}
            run={runOverview}
            opinionLoading={Boolean(opinion?.loading)}
            onAskOpinion={() => void askOpinion()}
            textareaRef={textareaRef}
          />
          </>
          )}
        </main>
      </div>

      {approval && <ApprovalModal request={approval} onRespond={respondApproval} />}
      {treeOpen && settings.activeProjectPath && (
        <ProjectTree
          key={settings.activeProjectPath}
          projectPath={settings.activeProjectPath}
          projectName={projectName}
          onClose={() => setTreeOpen(false)}
        />
      )}
      {opinion && <SecondOpinion state={opinion} onClose={() => setOpinion(null)} />}
      {unlockerOpen && (
        <UnlockerModal
          onClose={() => setUnlockerOpen(false)}
          onGoogleImported={() => {
            void hydrateProject()
            setToast('Google (Gemini Pro/Ultra) подключён!')
          }}
        />
      )}
      {settingsOpen && (
        <SettingsScreen
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onChanged={(view) => {
            applyView(view)
            void refreshContext()
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <AlertIcon size={15} />
          <span>{toast}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setToast('')}
            aria-label={t('chrome.closeToast')}
          >
            <XIcon size={13} />
          </button>
        </div>
      )}
      <WindowResizeHandles />
    </div>
  )
}
