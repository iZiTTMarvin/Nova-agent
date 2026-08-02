/** Workflow Agent consumer: stable command construction, result interpretation, and journal reuse. */
import { createHash } from 'crypto'
import * as Worktree from '../../worktree'
import type {
  JsonSchema,
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../../shared/subagents'
import { appendJournalSync, journalKeyBase } from '../state/journal'
import { extractJsonCandidates } from './jsonExtract'
import { createLogFn, type LogFn } from './progressFn'
import { ensureWorktree, releaseWorktree } from './worktreeFn'
import {
  assertScopeLive,
  type AgentOptions,
  type AgentResult,
  type HostContext,
  type IsolationMode
} from './types'

export type AgentFn = (prompt: string, opts?: AgentOptions) => Promise<AgentResult>

const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000
const ASK_QUESTION_TOOL = 'askQuestion'
const WORKFLOW_PROFILE_PROMPT =
  '你是 Workflow 派生的子代理。只完成分配任务，遵守工具结果与工作区边界，最后给出简洁且可验证的结果。'

export const BASE_TOOLS = [
  'ls',
  'read',
  'grep',
  'find',
  'edit',
  'write',
  'bash',
  'todo_write'
] as const

export const READONLY_TOOLS = ['ls', 'read', 'grep', 'find', 'web_search'] as const

export function resolveAgentTools(params: {
  isolation: IsolationMode
  autoMode: boolean
  interactive?: boolean
  tools?: string[]
}): string[] {
  const base = params.tools?.length
    ? [...params.tools]
    : params.isolation === 'readonly'
      ? [...READONLY_TOOLS]
      : [...BASE_TOOLS]
  const withoutAsk = [...new Set(base.filter((name) => name !== ASK_QUESTION_TOOL))]
  const mayAsk =
    params.interactive === true &&
    !params.autoMode &&
    params.isolation === 'shared'
  return mayAsk ? [...withoutAsk, ASK_QUESTION_TOOL] : withoutAsk
}

function resolveIsolation(opts: AgentOptions): IsolationMode {
  return opts.isolation ?? 'shared'
}

function resolveAgentType(opts: AgentOptions): string {
  return opts.phase ?? 'general'
}

function buildProfile(tools: readonly string[]): {
  profileId: string
  profile: Record<string, unknown>
} {
  const digest = createHash('sha256')
    .update(JSON.stringify([...tools].sort()), 'utf8')
    .digest('hex')
    .slice(0, 16)
  const profileId = `workflow-${digest}`
  return {
    profileId,
    profile: {
      name: profileId,
      description: 'Workflow-scoped validated child profile',
      prompt: WORKFLOW_PROFILE_PROMPT,
      allowedTools: [...tools],
      maxToolRounds: 30
    }
  }
}

function appendSchemaInstruction(prompt: string, schema: JsonSchema | undefined): string {
  if (!schema) return prompt
  return [
    prompt,
    '',
    '请严格按以下 JSON Schema 返回恰好一个 JSON 值；最终消息只输出 JSON，不要 markdown 围栏与解释：',
    JSON.stringify(schema)
  ].join('\n')
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonSchema(value: unknown): value is JsonSchema {
  if (typeof value === 'boolean') return true
  if (!isUnknownRecord(value)) return false
  const schema = value
  if (!['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'].includes(
    String(schema.type)
  )) return false
  if (schema.type === 'array' && schema.items !== undefined && !isJsonSchema(schema.items)) {
    return false
  }
  if (schema.type === 'object') {
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string'))
    ) return false
    if (schema.properties !== undefined) {
      if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
        return false
      }
      if (!Object.values(schema.properties).every(isJsonSchema)) return false
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== 'boolean' &&
      !isJsonSchema(schema.additionalProperties)
    ) return false
  }
  return true
}

function parseSchemaResult(schema: JsonSchema, text: string): Record<string, unknown> | null {
  if (schema === false) return null
  const required =
    typeof schema === 'object' && schema.type === 'object' && Array.isArray(schema.required)
      ? schema.required
      : []
  for (const candidate of extractJsonCandidates(text)) {
    if (!isUnknownRecord(candidate)) continue
    if (required.every((key) => key in candidate)) return candidate
  }
  return null
}

function reportFailure(
  ctx: HostContext,
  log: LogFn,
  label: string,
  reason: string
): void {
  if (reason === 'cancelled' || reason === 'interrupted') return
  ctx.eventBus.emit({
    type: 'workflow_agent_failed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    reason
  })
  log(`[${label}] 子代理未产出有效结果：${reason}`)
}

interface InvocationIdentity {
  readonly key: string
  readonly keyBase: string
  readonly occurrence: number
}

function nextInvocationIdentity(
  ctx: HostContext,
  prompt: string,
  opts: AgentOptions,
  tools: string[],
  isolation: IsolationMode
): InvocationIdentity {
  const keyBase = journalKeyBase(prompt, {
    agentType: resolveAgentType(opts),
    taskId: opts.taskId?.trim(),
    batchId: opts.batchId?.trim(),
    model: opts.model,
    schema: opts.schema,
    phase: opts.phase,
    tools,
    isolation,
    timeoutMs: opts.timeoutMs ?? null
  })
  const occurrenceKey = [
    opts.phase ?? ctx.currentPhase.name,
    opts.taskId?.trim() || keyBase,
    opts.batchId?.trim() || ''
  ].join('\0')
  const occurrence = ctx.occ.get(occurrenceKey) ?? 0
  ctx.occ.set(occurrenceKey, occurrence + 1)
  return { keyBase, occurrence, key: `${keyBase}:${occurrence}` }
}

async function spawnViaPort(
  ctx: HostContext,
  prompt: string,
  opts: AgentOptions,
  tools: string[],
  workingDirectory: string,
  isolation: IsolationMode,
  identity: InvocationIdentity
): Promise<{ result: AgentResult; execution: SubagentExecutionResult | null; reason?: string }> {
  if (!assertScopeLive(ctx) || !ctx.sessionId) {
    return { result: null, execution: null, reason: 'cancelled' }
  }
  const schema = opts.schema === undefined
    ? undefined
    : isJsonSchema(opts.schema)
      ? opts.schema
      : null
  if (schema === null) {
    return { result: null, execution: null, reason: 'schema-contract-invalid' }
  }
  const { profileId, profile } = buildProfile(tools)
  const phase = opts.phase ?? ctx.currentPhase.name
  const command: SpawnSubagentCommand = {
    parentSessionId: ctx.sessionId,
    parentRunId: ctx.parentRunId,
    invocation: {
      kind: 'workflow',
      workflowRunId: ctx.runId,
      phase,
      parentMessageId: ctx.parentMessageId,
      parentToolCallId: ctx.parentToolCallId,
      taskId: opts.taskId?.trim() || identity.keyBase,
      ...(opts.batchId?.trim() ? { batchId: opts.batchId.trim() } : {}),
      occurrence: identity.occurrence
    },
    profileId,
    task: appendSchemaInstruction(prompt, schema),
    workingDirectory,
    isolation,
    ...(schema ? { resultSchema: schema } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  }

  let execution: SubagentExecutionResult
  try {
    execution = await ctx.spawnSubagentPort.spawn(command, {
      profile,
      abortSignal: ctx.abortSignal,
      waitForPermit: true
    })
  } catch (error) {
    return {
      result: null,
      execution: null,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (execution.status !== 'completed') {
    return {
      result: null,
      execution,
      reason: execution.failure?.code ?? execution.status
    }
  }
  if (schema) {
    const parsed = parseSchemaResult(schema, execution.summary)
    return parsed
      ? { result: parsed, execution }
      : { result: null, execution, reason: 'schema-parse-failed' }
  }
  return { result: execution.summary, execution }
}

export function createAgentFn(ctx: HostContext): AgentFn {
  const log = createLogFn(ctx)
  return async (prompt, opts = {}) => {
    const promptText = String(prompt ?? '')
    const isolation = resolveIsolation(opts)
    const phase = opts.phase ?? ctx.currentPhase.name
    const effectiveOpts: AgentOptions = { ...opts, phase }
    const label = effectiveOpts.label ?? phase
    const tools = resolveAgentTools({
      isolation,
      autoMode: ctx.autoMode,
      interactive: opts.interactive,
      tools: opts.tools
    })
    const identity = nextInvocationIdentity(ctx, promptText, effectiveOpts, tools, isolation)

    if (ctx.journal.results.has(identity.key)) {
      return ctx.journal.results.get(identity.key) as AgentResult
    }

    let workingDirectory = opts.directory?.trim() || ctx.workspaceRoot
    let ownedDirectory: string | null = null
    if (!opts.directory && isolation === 'worktree') {
      try {
        const handle = await ensureWorktree(
          ctx,
          opts.worktreeKey?.trim() || `agent-${identity.keyBase.slice(0, 12)}`
        )
        workingDirectory = handle.directory
        ownedDirectory = handle.directory
      } catch {
        reportFailure(ctx, log, label, 'worktree-create-failed')
        return null
      }
    }

    const outcome = await spawnViaPort(
      ctx,
      promptText,
      effectiveOpts,
      tools,
      workingDirectory,
      isolation,
      identity
    )
    if (outcome.result === null || !outcome.execution) {
      if (ownedDirectory) await releaseWorktree(ctx, ownedDirectory)
      reportFailure(ctx, log, label, outcome.reason ?? 'host')
      return null
    }

    if (ownedDirectory) {
      const owned = ctx.ownedWorktrees.get(ownedDirectory)
      const pristine = owned
        ? await Worktree.isPristine(ownedDirectory, owned.baseSha).catch(() => false)
        : false
      if (pristine) await releaseWorktree(ctx, ownedDirectory)
    }

    if (assertScopeLive(ctx)) {
      const event = {
        t: 'agent' as const,
        key: identity.key,
        result: outcome.result,
        childSessionId: outcome.execution.childSessionId,
        childRunId: outcome.execution.childRunId,
        pass: ctx.journal.pass
      }
      try {
        appendJournalSync(ctx.workspaceRoot, ctx.runId, [event])
        ctx.journal.results.set(identity.key, outcome.result)
        ctx.journal.childRefs.set(identity.key, {
          childSessionId: outcome.execution.childSessionId,
          childRunId: outcome.execution.childRunId
        })
      } catch {
        // journal 只是 resume 优化；durable Child Session 仍是执行事实源。
      }
    }
    return outcome.result
  }
}
