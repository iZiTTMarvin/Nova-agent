import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { AgentLoop, EventBus } from '../runtime/agent'
import { agentRoute } from '../runtime/agent/turn'
import {
  buildStableSystemPrompt,
  discoverProjectRules,
  getHeadlessExecutionInstruction,
  renderBaseRules,
  renderModeToolInventory,
  resolveTaskPolicy
} from '../runtime/agent'
import { OpenAICompatibleModelClient } from '../runtime/model/OpenAICompatibleModelClient'
import { createEnvProxyFetch, describeEnvProxy } from './envProxyFetch'
import { writeAndExit } from './writeAndExit'
import { resolveCacheProfile } from '../runtime/model/cacheProfile'
import { resolveContextWindow } from '../shared/config'
import { ToolRegistry } from '../runtime/tools/ToolRegistry'
import { ToolAvailability, listLiveDeferredGroupIds } from '../runtime/tools/availability'
import { createLoadToolsTool } from '../runtime/tools/loadTools'
import { projectEffectiveToolDefinitions } from '../runtime/agent/core/AgentContext'
import { ArtifactStore } from '../runtime/artifacts/ArtifactStore'
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
  accumulateRepairTotals,
  accumulateRepairOutcomes,
  type HeadlessTurnReport
} from './summary'
import { buildAtifTrajectory } from './atif'
import { resolveHeadlessMaxToolRounds } from './roundBudget'
import { headlessAssistantCompletionPolicy } from './completionPolicy'

interface CliOptions {
  workdir: string
  logsDir: string
  model: string
  baseUrl: string
  reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  maxToolRounds: number
  deadlineSeconds?: number
  instructionFile?: string
  /** 显式上下文窗口覆盖；缺省时由模型元数据解析 */
  contextWindow?: number
  economyTaskMode?: boolean
  heavyTaskMode?: boolean
  taskCategory?: string
  taskTags?: string[]
  /** 强制开启工具分组过滤（即使任务分级不是 economy） */
  toolEconomy?: boolean
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
    'instruction-file',
    'context-window',
    'economy-task-mode',
    'heavy-task-mode',
    'task-category',
    'task-tags',
    'tool-economy'
  ])
  const flagOnly = new Set([
    'economy-task-mode',
    'heavy-task-mode',
    'tool-economy'
  ])
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`)
    const name = arg.slice(2)
    if (!supported.has(name)) throw new Error(`无法识别的参数: ${arg}`)
    if (flagOnly.has(name)) {
      flags.add(name)
      continue
    }
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
  const deadlineValue = values.get('deadline-seconds')
  const deadlineSeconds = deadlineValue === undefined ? undefined : Number(deadlineValue)
  if (deadlineSeconds !== undefined && (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0)) {
    throw new Error('--deadline-seconds 必须是正数')
  }
  const maxToolRounds = resolveHeadlessMaxToolRounds(
    values.get('max-tool-rounds'),
    deadlineSeconds
  )
  const contextWindowValue = values.get('context-window')
  const contextWindow = contextWindowValue === undefined ? undefined : Number(contextWindowValue)
  if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error('--context-window 必须是正整数')
  }

  const taskTagsRaw = values.get('task-tags')
  const taskTags = taskTagsRaw
    ? taskTagsRaw.split(',').map(t => t.trim()).filter(Boolean)
    : undefined

  return {
    workdir,
    logsDir,
    model: values.get('model') ?? 'deepseek-v4-flash',
    baseUrl: values.get('base-url') ?? 'https://api.deepseek.com',
    reasoningEffort: effort as CliOptions['reasoningEffort'],
    maxToolRounds,
    ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(values.get('instruction-file')
      ? { instructionFile: resolve(values.get('instruction-file')!) }
      : {}),
    ...(flags.has('economy-task-mode') ? { economyTaskMode: true } : {}),
    ...(flags.has('heavy-task-mode') ? { heavyTaskMode: true } : {}),
    ...(values.get('task-category') ? { taskCategory: values.get('task-category') } : {}),
    ...(taskTags ? { taskTags } : {}),
    ...(flags.has('tool-economy') ? { toolEconomy: true } : {})
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

function createCodingTools(availability: ToolAvailability | null): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(lsTool)
  registry.register(readTool)
  registry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  registry.register(findTool)
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(bashTool)
  registry.register(archiveReadTool)
  // 连接器只在存在 live deferred 组时下发；headless 编码工具集没有组成员，恒不注册
  if (availability) {
    const registeredToolNames = registry.getToolDefinitions().map(def => def.name)
    if (listLiveDeferredGroupIds(registeredToolNames).length > 0) {
      registry.register(
        createLoadToolsTool({
          getAvailability: () => availability,
          registeredToolNames
        })
      )
    }
    availability.bindRegisteredToolNames(
      registry.getToolDefinitions().map(def => def.name)
    )
  }
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
  delete process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY 环境变量')

  const taskPolicy = resolveTaskPolicy({
    instruction,
    surface: 'headless',
    economyTaskMode: options.economyTaskMode,
    heavyTaskMode: options.heavyTaskMode,
    category: options.taskCategory,
    tags: options.taskTags
  })
  const toolEconomyEnabled = taskPolicy.toolEconomy || options.toolEconomy === true
  const toolAvailability = new ToolAvailability()
  toolAvailability.setEconomyMode(toolEconomyEnabled ? 'on' : 'off')

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

  const registry = createCodingTools(toolEconomyEnabled ? toolAvailability : null)
  const definitions = projectEffectiveToolDefinitions(
    'default',
    registry.getToolDefinitions(),
    toolAvailability
  )
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
    supportsVision: false,
    // 隔离评测 / 企业内网只放行代理出网；无代理环境变量时返回 undefined，行为不变
    fetchImpl: createEnvProxyFetch()
  })
  // 传输路径写入汇总，便于隔离环境网络问题的现场诊断（不含代理凭据）
  const proxyTransport = describeEnvProxy()
  const loop = new AgentLoop(modelClient, eventBus, {
    systemPromptLayers: {
      agentRole: buildStableSystemPrompt({
        workingDir: options.workdir,
        surface: 'headless'
      }),
      baseRules: renderBaseRules(),
      projectRules: discoverProjectRules(options.workdir)?.text ?? '',
      modeInstruction: '',
      taskPolicy: taskPolicy.systemLayerText,
      toolSummary: renderModeToolInventory('default', definitions, { dialect: 'native' })
    },
    maxToolRounds: options.maxToolRounds,
    // 显式参数优先；缺省时由模型元数据解析（不再硬编码 1M，避免压缩阈值永不触发）
    contextWindow: options.contextWindow ?? resolveContextWindow(options.model),
    supportsVision: false,
    toolExecution: 'parallel',
    maxParallelToolCalls: 4
  })
  loop.setToolRegistry(registry)
  loop.setToolAvailability(toolAvailability)
  loop.setArtifactStore(new ArtifactStore(options.logsDir))
  loop.setSessionId(runId)
  loop.setWorkingDir(options.workdir)
  loop.setWorkspaceRoot(options.workdir)
  loop.setRunRef(runId)
  loop.setMode('default')
  loop.setModeInstructionProvider(getHeadlessExecutionInstruction)
  if (options.deadlineSeconds !== undefined) {
    loop.setAssistantCompletionPolicy(headlessAssistantCompletionPolicy)
  }

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
  const atif = buildAtifTrajectory({
    instruction,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    events
  })

  writeJson(trajectoryPath, {
    schema_version: 'ATIF-v1.7',
    session_id: runId,
    agent: {
      name: 'nova-headless',
      version: process.env.NOVA_VERSION ?? 'workspace',
      model_name: options.model,
      extra: { reasoning_effort: options.reasoningEffort }
    },
    steps: atif.steps,
    final_metrics: {
      total_prompt_tokens: usage.uncachedInputTokens + usage.cacheReadTokens,
      total_completion_tokens: usage.outputTokens,
      total_cached_tokens: usage.cacheReadTokens,
      total_steps: atif.totalSteps,
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
    proxy_transport: proxyTransport,
    max_tool_rounds: Number.isFinite(options.maxToolRounds)
      ? options.maxToolRounds
      : null,
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
    tool_calls: atif.steps.reduce((sum, step) => sum + (step.tool_calls?.length ?? 0), 0),
    model_calls: atif.llmCallCount,
    repair: accumulateRepairTotals(events),
    repair_outcome: accumulateRepairOutcomes(events),
    task_policy: {
      tier: taskPolicy.tier,
      matched_by: taskPolicy.matchedBy,
      tool_economy: toolEconomyEnabled
    }
  }
  writeJson(summaryPath, summary)
  // 摘要是进程的最后输出：写完立即退出，不等待事件循环排空。
  // 任务可能遗留 nohup 后台进程继承工具管道等句柄，靠事件循环自然退出
  // 会永远挂住，把外部调用方（评测 harness）卡死。
  writeAndExit(process.stdout, `${JSON.stringify(summary)}\n`, summaryDerivation.exitNonZero ? 1 : 0)
}

main().catch(error => {
  writeAndExit(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`, 1)
})
