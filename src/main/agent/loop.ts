import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  ApprovalAnswer,
  ApprovalRequest,
  EffortLevel,
  ProviderKind,
  UserQuestion
} from '../../shared/types'
import { maxTokensFor, reasoningEffortFor, temperatureFor, thinkingBudgetFor } from '../../shared/modelNames'
import { abandonRequest, beginRequest } from '../load'
import type { ChatMessage, ProviderResult, ProviderStream, ToolSchema } from '../llm/types'
import { streamAnthropic } from '../llm/anthropic'
import { streamOpenAi } from '../llm/openai'
import { compactHistoryIfNeeded } from './context'
import { tr } from '../lang'
import { findEntry } from '../library'
import {
  agentTools,
  readOnlyToolNames,
  runTool,
  type ImageCapability,
  type ProjectRef,
  type QuestionInput,
  type ScreenCapability,
  type ToolContext
} from './tools'

export interface AgentRunOptions {
  provider: { kind: ProviderKind; apiKey: string; baseUrl: string; models?: string[] }
  model: string
  system: string
  messages: ChatMessage[]
  projectRoot: string | null
  signal: AbortSignal
  effort: EffortLevel
  emit: (event: AgentEvent) => void
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalAnswer>
  requestQuestion?: (question: UserQuestion) => Promise<string>
  grantRootFor: (absolutePath: string) => string | null
  grant: (absolutePath: string) => void
  image?: ImageCapability
  screen?: ScreenCapability
  projects?: ProjectRef[]
  onProjectSwitch?: (absolutePath: string) => void
  onProgress?: () => void
  onAssistantTurn?: (message: ChatMessage) => void
  onUserTurnAttached?: (message: ChatMessage) => void
  compactThreshold?: number
  parentCallId?: string | null
  agentName?: string | null
  depth?: number
  onRotateAccount?: () => Promise<{
    switched: boolean
    providerLabel: string
    model: string
    provider: { kind: ProviderKind; apiKey: string; baseUrl: string; models?: string[] }
  } | null>
}

const MAX_ROUNDS = 32
const SUBAGENT_MAX_ROUNDS = 8
const SUBAGENT_REPORT_CHARS = 12_000

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

const OVERFLOW_HINT =
  /(maximum context|context (length|window)|prompt is too long|too many tokens|token limit|input is too (long|large)|request entity too large|\b413\b)/i

const MAX_OVERFLOW_RETRIES = 3

function isContextOverflow(error: unknown): boolean {
  return OVERFLOW_HINT.test(
    `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`
  )
}

function makeRoom(
  options: AgentRunOptions,
  messages: ChatMessage[],
  system: string,
  emit: (event: AgentEvent) => void,
  force: boolean
): Promise<void> {
  return compactHistoryIfNeeded({
    messages,
    system,
    provider: options.provider,
    model: options.model,
    signal: options.signal,
    emit,
    source: 'auto',
    effort: options.effort,
    threshold: options.compactThreshold,
    force
  }).then(() => undefined)
}

function toolsFor(options: AgentRunOptions): ToolSchema[] {
  const readOnly = (options.depth ?? 0) > 0
  const names = new Set<string>(
    readOnly ? [...readOnlyToolNames, 'run_subagent'] : agentTools.map((tool) => tool.name)
  )
  if ((options.depth ?? 0) > 0) names.delete('run_subagent')
  if (!options.image?.models.length) names.delete('generate_image')
  if (!options.screen) names.delete('take_screenshot')
  if (!options.requestQuestion) names.delete('ask_user')
  return agentTools.filter((tool) => names.has(tool.name))
}

function askerFor(
  options: AgentRunOptions
): ((question: QuestionInput) => Promise<string>) | undefined {
  const ask = options.requestQuestion
  if (!ask || (options.depth ?? 0) > 0) return undefined
  return async (input) => await ask({ id: randomUUID(), ...input })
}

async function delegate(
  options: AgentRunOptions,
  entry: { name: string; body: string; model: string | null },
  task: string,
  callId: string
): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: task }]
  const emit: (event: AgentEvent) => void = (event) => {
    if (event.type === 'text-delta') return
    if (event.type === 'tool-start') {
      options.emit({ ...event, parent: callId, agent: entry.name })
      return
    }
    if (event.type === 'tool-end') {
      options.emit({ ...event, parent: callId })
      return
    }
    options.emit(event)
  }

  const subModel =
    entry.model && options.provider.models?.includes(entry.model) ? entry.model : options.model
  const sub: AgentRunOptions = {
    ...options,
    model: subModel,
    system: `${options.system}\n\n${entry.body}`.slice(0, 40_000),
    messages,
    parentCallId: callId,
    agentName: entry.name,
    depth: (options.depth ?? 0) + 1,
    emit
  }

  let report = ''
  let overflowRetries = 0
  for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
    if (options.signal.aborted) throw abortError()
    await makeRoom(sub, messages, sub.system, emit, false)
    const stream: ProviderStream =
      options.provider.kind === 'anthropic' ? streamAnthropic : streamOpenAi
    const trace = beginRequest(sub.model)
    let outcome: ProviderResult
    try {
      outcome = await stream(
        {
          apiKey: options.provider.apiKey,
          baseUrl: options.provider.baseUrl,
          model: sub.model,
          system: sub.system,
          messages,
          tools: toolsFor(sub),
          signal: options.signal,
          maxTokens: maxTokensFor(options.effort),
          temperature: temperatureFor(options.effort),
          reasoningEffort: reasoningEffortFor(sub.model, options.effort),
          thinkingBudget: thinkingBudgetFor(sub.model, options.effort)
        },
        (text) => {
          trace.firstToken()
          trace.delta(text)
        }
      )
      trace.done()
    } catch (error) {
      abandonRequest(trace.id)
      trace.done()
      if (
        !isContextOverflow(error) ||
        overflowRetries >= MAX_OVERFLOW_RETRIES ||
        options.signal.aborted
      ) {
        throw error
      }
      overflowRetries++
      await makeRoom(sub, messages, sub.system, emit, true)
      continue
    }

    messages.push({ role: 'assistant', content: outcome.text, toolCalls: outcome.toolCalls })
    report = outcome.text.trim() || report
    if (!outcome.toolCalls.length) break

    for (const call of outcome.toolCalls) {
      if (options.signal.aborted) throw abortError()
      let args: Record<string, unknown> = {}
      let invalidArgs = false
      try {
        const parsed = JSON.parse(call.arguments || '{}') as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else {
          invalidArgs = true
        }
      } catch {
        invalidArgs = true
      }
      emit({ type: 'tool-start', id: call.id, name: call.name, args })
      const result = invalidArgs
        ? { ok: false, content: 'Invalid tool arguments: expected a JSON object.', detail: tr('e.badSettings') }
        : await runTool(call.name, args, contextFor(sub))
      messages.push({ role: 'tool', toolCallId: call.id, content: result.content })
      emit({ type: 'tool-end', id: call.id, ok: result.ok, detail: result.detail })
    }
  }

  if (!report && messages.length > 1) {
    const findings = messages
      .filter((m) => m.role === 'tool')
      .slice(-3)
      .map((m) => m.content)
      .join('\n')
    if (findings) report = findings
  }
  return report.slice(0, SUBAGENT_REPORT_CHARS) || '(no findings)'
}

function contextFor(options: AgentRunOptions): ToolContext {
  return {
    root: options.projectRoot,
    projectPath: options.projectRoot,
    allowWrite: false,
    grantRootFor: options.grantRootFor,
    grant: options.grant,
    projects: options.projects,
    image: options.image,
    screen: options.screen,
    requestApproval: async (input) => {
      const request: ApprovalRequest = { id: randomUUID(), ...input }
      return options.requestApproval(request)
    }
  }
}

export async function runAgent(options: AgentRunOptions): Promise<void> {
  const stream: ProviderStream =
    options.provider.kind === 'anthropic' ? streamAnthropic : streamOpenAi
  const { signal } = options
  let overflowRetries = 0

  let round = 0
  while (round < MAX_ROUNDS) {
    if (signal.aborted) throw abortError()
    await makeRoom(options, options.messages, options.system, options.emit, false)

    options.emit({ type: 'assistant-start' })
    const trace = beginRequest(options.model)
    let result: ProviderResult
    try {
      result = await stream(
        {
          apiKey: options.provider.apiKey,
          baseUrl: options.provider.baseUrl,
          model: options.model,
          system: options.system,
          messages: options.messages,
          tools: toolsFor(options),
          signal,
          maxTokens: maxTokensFor(options.effort),
          temperature: temperatureFor(options.effort),
          reasoningEffort: reasoningEffortFor(options.model, options.effort),
          thinkingBudget: thinkingBudgetFor(options.model, options.effort)
        },
        (text) => {
          trace.firstToken()
          trace.delta(text)
          options.emit({ type: 'text-delta', text })
        }
      )
      trace.done()
    } catch (error) {
      abandonRequest(trace.id)
      trace.done()
      const errText = (error instanceof Error ? error.message : String(error)).toLowerCase()
      const isQuota =
        errText.includes('429') ||
        errText.includes('quota') ||
        errText.includes('resource_exhausted') ||
        errText.includes('rate_limit') ||
        errText.includes('insufficient_quota') ||
        errText.includes('limit reached') ||
        errText.includes('credit') ||
        errText.includes('forbidden') ||
        errText.includes('403') ||
        errText.includes('unauthorized') ||
        errText.includes('401')
      if (isQuota && options.onRotateAccount && !signal.aborted) {
        const rotated = await options.onRotateAccount()
        if (rotated?.switched) {
          options.provider = rotated.provider
          options.model = rotated.model
          options.emit({
            type: 'text-delta',
            text: `\n\n> ⚡ *Лимит квоты исчерпан (0%). Автоматически переключено на аккаунт: **${rotated.providerLabel}** (${rotated.model}). Автоматически продолжаю разговор...*\n\n`
          })
          continue
        }
      }
      if (!isContextOverflow(error) || overflowRetries >= MAX_OVERFLOW_RETRIES || signal.aborted) {
        throw error
      }
      overflowRetries++
      await makeRoom(options, options.messages, options.system, options.emit, true)
      continue
    }
    round++

    const turn: ChatMessage = {
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls
    }
    options.messages.push(turn)
    options.onAssistantTurn?.(turn)
    options.onProgress?.()

    if (!result.toolCalls.length) return

    for (const call of result.toolCalls) {
      if (signal.aborted) throw abortError()

      let args: Record<string, unknown> = {}
      let invalidArgs = false
      try {
        const parsed = JSON.parse(call.arguments || '{}') as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        } else {
          invalidArgs = true
        }
      } catch {
        invalidArgs = true
      }

      options.emit({
        type: 'tool-start',
        id: call.id,
        name: call.name,
        args,
        parent: options.parentCallId ?? null,
        agent: options.agentName ?? null
      })

      const outcome = invalidArgs
        ? { ok: false, content: 'Invalid tool arguments: expected a JSON object.', detail: tr('e.badSettings') }
        : await runTool(call.name, args, {
            root: options.projectRoot,
            projectPath: options.projectRoot,
            allowWrite: (options.depth ?? 0) === 0,
            image: options.image,
            screen: options.screen,
            projects: options.projects,
            grantRootFor: options.grantRootFor,
            grant: options.grant,
            requestApproval: async (input) => {
              const request: ApprovalRequest = { id: randomUUID(), ...input }
              return options.requestApproval(request)
            },
            requestQuestion: askerFor(options),
            delegate: async (agentName, task) => {
              const entry = findEntry('agent', agentName, options.projectRoot)
              if (!entry) throw new Error(tr('e.badAgentName', { name: agentName }))
              return await delegate(
                { ...options, messages: options.messages },
                { name: entry.name, body: entry.body, model: entry.model },
                task,
                call.id
              )
            }
          })

      options.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: outcome.content
      })
      if (outcome.attach?.length) {
        const attachTurn: ChatMessage = {
          role: 'user',
          content: 'The picture the tool captured is attached to this message.',
          images: outcome.attach
        }
        options.messages.push(attachTurn)
        options.onUserTurnAttached?.(attachTurn)
      }
      options.emit({
        type: 'tool-end',
        id: call.id,
        ok: outcome.ok,
        detail: outcome.detail,
        parent: options.parentCallId ?? null
      })
      if (outcome.image) {
        options.emit({
          type: 'image',
          id: call.id,
          path: outcome.image.path,
          absolutePath: outcome.image.absolutePath,
          mime: outcome.image.mime,
          bytes: outcome.image.bytes
        })
      }
      if (outcome.edit) {
        options.emit({ type: 'edit', id: call.id, ...outcome.edit })
      }
      if (outcome.projectSwitch) options.onProjectSwitch?.(outcome.projectSwitch)
      options.onProgress?.()

      if (signal.aborted) throw abortError()
    }
  }

  throw new Error(tr('e.stepLimit'))
}
