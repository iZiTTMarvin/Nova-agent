import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { AgentLoop, EventBus } from '../runtime/agent'
import { agentRoute } from '../runtime/agent/turn'
import {
  buildStableSystemPrompt,
  discoverProjectRules,
  renderBaseRules,
  renderModeToolInventory
} from '../runtime/agent'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import { resolveCacheProfile } from '../runtime/model/cacheProfile'
import { ToolRegistry } from '../runtime/tools/ToolRegistry'
import { lsTool } from '../runtime/tools/lsTool'
import { readTool } from '../runtime/tools/readTool'
import { createGrepTool } from '../runtime/tools/grepTool'
import { findTool } from '../runtime/tools/findTool'
import { editTool } from '../runtime/tools/editTool'
import { writeTool } from '../runtime/tools/writeTool'
import { bashTool } from '../runtime/tools/bashTool'
import { archiveReadTool } from '../runtime/tools/archiveRead'
import type { AgentEvent } from '../runtime/agent/types'
import type { NormalizedUsage } from '../shared/model/types'
import {
  deriveHeadlessSummary,
  type HeadlessTurnReport
} from './summary'

interface CliOptions {
  workdir: string
  logsDir: string
  model: string
  baseUrl: string
  reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  maxToolRounds: number
  deadlineSeconds?: number
  instructionFile?: string
}

interface UsageTotals {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

function parseArgs(argv: string[]): CliOptions {
  const supported = new Set([
    'workdir',
    'logs-dir',
    'model',
    'base-url',
    'reasoning-effort',
    'max-tool-rounds',
    'deadline-seconds',
    'instruction-file'
  ])
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`)
    const name = arg.slice(2)
    if (!supported.has(name)) throw new Error(`无法识别的参数: ${arg}`)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`)
    values.set(name, value)
    i += 1
  }

  const workdir = resolve(values.get('workdir') ?? process.cwd())
  const logsDir = resolve(values.get('logs-dir') ?? resolve(workdir, '.nova-headless'))
  const effort = values.get('reasoning-effort') ?? 'max'
  if (!['low', 'medium', 'high', 'max'].includes(effort)) {
    throw new Error(`不支持的 reasoning effort: ${effort}`)
  }
  const maxToolRounds = Number(values.get('max-tool-rounds') ?? '100')
  if (!Number.isInteger(maxToolRounds) || maxToolRounds < 1) {
    throw new Error('--max-tool-rounds 必须是正整数')
  }
  const deadlineValue = values.get('deadline-seconds')
  const deadlineSeconds = deadlineValue === undefined ? undefined : Number(deadlineValue)
  if (deadlineSeconds !== undefined && (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0)) {
    throw new Error('--deadline-seconds 必须是正数')
  }

  return {
    workdir,
    logsDir,
    model: values.get('model') ?? 'deepseek-v4-flash',
    baseUrl: values.get('base-url') ?? 'https://api.deepseek.com',
    reasoningEffort: effort as CliOptions['reasoningEffort'],
    maxToolRounds,
    ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
    ...(values.get('instruction-file')
      ? { instructionFile: resolve(values.get('instruction-file')!) }
      : {})
  }
}

async function readInstruction(filePath?: string): Promise<string> {
  if (filePath) return readFileSync(filePath, 'utf8')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function createCodingTools(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(lsTool)
  registry.register(readTool)
  registry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  registry.register(findTool)
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(bashTool)
  registry.register(archiveReadTool)
  return registry
}

function addUsage(total: UsageTotals, usage: NormalizedUsage): void {
  total.uncachedInputTokens += usage.uncachedInputTokens
  total.cacheReadTokens += usage.cacheReadTokens
  total.cacheWriteTokens += usage.cacheWriteTokens
  total.outputTokens += usage.outputTokens
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const instruction = (await readInstruction(options.instructionFile)).trim()
  if (!instruction) throw new Error('任务指令为空')

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY 环境变量')

  mkdirSync(options.logsDir, { recursive: true })
  const eventsPath = resolve(options.logsDir, 'events.jsonl')
  const summaryPath = resolve(options.logsDir, 'summary.json')
  const trajectoryPath = resolve(options.logsDir, 'trajectory.json')
  const runId = randomUUID()
  const startedAt = new Date()
  const usage: UsageTotals = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0
  }
  const events: AgentEvent[] = []
  let deadlineReached = false

  const registry = createCodingTools()
  const definitions = registry.getToolDefinitions()
  const eventBus = new EventBus()
  eventBus.on(event => {
    events.push(event)
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
    if (event.type === 'usage') addUsage(usage, event.usage)
  })
  const modelClient = new OpenAICompatibleModelClient({
    apiKey,
    baseUrl: options.baseUrl,
    modelId: options.model,
    cacheProfile: resolveCacheProfile(options.baseUrl, options.model).id,
    reasoningEffort: options.reasoningEffort,
    supportsVision: false
  })
  const loop = new AgentLoop(modelClient, eventBus, {
    systemPromptLayers: {
      agentRole: buildStableSystemPrompt({ workingDir: options.workdir }),
      baseRules: renderBaseRules(),
      projectRules: discoverProjectRules(options.workdir)?.text ?? '',
      modeInstruction: '',
      toolSummary: renderModeToolInventory('default', definitions, { dialect: 'native' })
    },
    maxToolRounds: options.maxToolRounds,
    contextWindow: 1_000_000,
    supportsVision: false,
    toolExecution: 'parallel',
    maxParallelToolCalls: 4
  })
  loop.setToolRegistry(registry)
  loop.setWorkingDir(options.workdir)
  loop.setWorkspaceRoot(options.workdir)
  loop.setRunRef(runId)
  loop.setMode('default')

  let error: string | undefined
  const deadlineTimer = options.deadlineSeconds === undefined
    ? undefined
    : setTimeout(() => {
        deadlineReached = true
        loop.cancel()
      }, options.deadlineSeconds * 1000)
  let report: HeadlessTurnReport
  try {
    const outcome = await loop.sendMessage(instruction, agentRoute())
    if (outcome.status === 'incomplete') {
      report = { status: 'incomplete', reason: outcome.reason, deadlineReached }
    } else if (outcome.status === 'failed') {
      report = { status: 'failed', deadlineReached }
      error = outcome.error.message
    } else {
      report = { status: outcome.status, deadlineReached }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    report = { status: 'failed', deadlineReached }
  } finally {
    clearTimeout(deadlineTimer)
    loop.dispose()
  }

  const summaryDerivation = deriveHeadlessSummary(report)

  const finishedAt = new Date()
  const assistantText = events
    .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map(event => event.delta)
    .join('')
  const reasoningText = events
    .filter((event): event is Extract<AgentEvent, { type: 'thinking_delta' }> => event.type === 'thinking_delta')
    .map(event => event.delta)
    .join('')
  const toolCalls = events
    .filter((event): event is Extract<AgentEvent, { type: 'tool_call' }> => event.type === 'tool_call')
    .map(event => ({
      tool_call_id: event.toolCallId,
      function_name: event.toolName,
      arguments: event.args
    }))
  const observations = events
    .filter((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result')
    .map(event => ({ source_call_id: event.toolCallId, content: event.result }))

  writeJson(trajectoryPath, {
    schema_version: 'ATIF-v1.7',
    session_id: runId,
    agent: {
      name: 'nova-headless',
      version: process.env.NOVA_VERSION ?? 'workspace',
      model_name: options.model,
      extra: { reasoning_effort: options.reasoningEffort }
    },
    steps: [
      { step_id: 1, source: 'user', message: instruction, timestamp: startedAt.toISOString() },
      {
        step_id: 2,
        source: 'agent',
        message: assistantText,
        timestamp: finishedAt.toISOString(),
        llm_call_count: events.filter(event => event.type === 'usage').length,
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(observations.length > 0 ? { observation: { results: observations } } : {})
      }
    ],
    final_metrics: {
      total_prompt_tokens: usage.uncachedInputTokens + usage.cacheReadTokens,
      total_completion_tokens: usage.outputTokens,
      total_cached_tokens: usage.cacheReadTokens,
      total_steps: 2,
      extra: {
        cache_write_tokens: usage.cacheWriteTokens,
        uncached_input_tokens: usage.uncachedInputTokens
      }
    }
  })

  const summary = {
    schema_version: 1,
    run_id: runId,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    deadline_seconds: options.deadlineSeconds,
    deadline_reached: deadlineReached,
    status: report.status,
    budget_exhausted: summaryDerivation.budgetExhausted,
    failure_class: summaryDerivation.failureClass,
    error,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_seconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
    usage,
    tool_calls: toolCalls.length,
    model_calls: events.filter(event => event.type === 'usage').length
  }
  writeJson(summaryPath, summary)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  if (summaryDerivation.exitNonZero) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
