/** 临时注入对照策略，仅用于真实模型评测。 */
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { HookHandler } from '../../../../src/runtime/agent/core/HookManager'
const MEMORY_PREFETCH_TIMEOUT_MS = 200

export interface MemoryPrefetchPort {
  buildInjectionBlock(input: {
    query: string
    projectScopeId: string
    workspaceRoot?: string
  }): Promise<string | null>
}

export interface WorkingStateObservation {
  toolName: string
  title: string
  facts: readonly string[]
  filesTouched: readonly string[]
}

export interface WorkingStatePort {
  peekRecent(limit: number): readonly WorkingStateObservation[]
}

export interface MemoryPrefetchWiringInput {
  prefetch: MemoryPrefetchPort
  projectScopeId: string
  workspaceRoot?: string
  workingState: WorkingStatePort
  timeoutMs?: number
}

export interface MemoryPrefetchWiring {
  onMessageStart: HookHandler<'onMessageStart'>
  context: HookHandler<'context'>
}

const STATE_OBSERVATION_WINDOW = 1
const STATE_FACTS_PER_OBSERVATION = 2
const STATE_TEXT_MAX_CHARS = 160

interface TurnPrefetchState {
  messageId: string
  query: string
  stateSignature: string | null
  blockPromise: Promise<string | null> | null
  block: string | null
}

export function createMemoryPrefetchWiring(input: MemoryPrefetchWiringInput): MemoryPrefetchWiring {
  const timeoutMs = input.timeoutMs ?? MEMORY_PREFETCH_TIMEOUT_MS
  let turn: TurnPrefetchState | null = null

  const onMessageStart: HookHandler<'onMessageStart'> = (payload) => {
    turn = {
      messageId: payload.messageId,
      query: payload.text,
      stateSignature: null,
      blockPromise: null,
      block: null
    }
  }

  const context: HookHandler<'context'> = async (payload) => {
    if (!turn || turn.messageId !== payload.messageId) return undefined

    const stateText = buildStateText(input.workingState.peekRecent(STATE_OBSERVATION_WINDOW))
    if (!turn.query.trim() && !stateText) return undefined
    if (turn.blockPromise === null || stateText !== turn.stateSignature) {
      turn.stateSignature = stateText
      turn.blockPromise = raceWithTimeout(
        input.prefetch.buildInjectionBlock({
          query: composeQuery(turn.query, stateText),
          projectScopeId: input.projectScopeId,
          workspaceRoot: input.workspaceRoot
        }),
        timeoutMs
      )
    }
    const block = (turn.block = await turn.blockPromise)
    if (!block) return undefined

    const ephemeral: ChatMessage = { role: 'user', content: block, skipCacheMarker: true }
    return { messages: [...payload.messages, ephemeral] }
  }

  return { onMessageStart, context }
}

function buildStateText(observations: readonly WorkingStateObservation[]): string {
  const latest = observations[observations.length - 1]
  if (!latest) return ''
  const parts: string[] = [...latest.facts.slice(0, STATE_FACTS_PER_OBSERVATION)]
  if (parts.length === 0) {
    parts.push(latest.title)
  }
  for (const file of latest.filesTouched) {
    parts.push(file)
  }
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
  return text.length <= STATE_TEXT_MAX_CHARS ? text : text.slice(0, STATE_TEXT_MAX_CHARS)
}

function composeQuery(openingText: string, stateText: string): string {
  if (!stateText) return openingText
  if (!openingText.trim()) return stateText
  return `${stateText} ${openingText}`
}

function raceWithTimeout(promise: Promise<string | null>, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}
