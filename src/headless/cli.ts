import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
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
import {
  ToolAvailability,
  listLiveDeferredGroupIds
} from '../runtime/tools/availability'
import { validateRegisteredToolsAreCataloged } from '../runtime/tools/catalog'
import { createLoadToolsTool } from '../runtime/tools/loadTools'
import { applyLedgerToolVisibility, projectEffectiveToolDefinitions } from '../runtime/agent/core/AgentContext'
import { ArtifactStore } from '../runtime/artifacts/ArtifactStore'
import { lsTool } from '../runtime/tools/lsTool'
import { readTool } from '../runtime/tools/readTool'
import { createGrepTool } from '../runtime/tools/grepTool'
import { findTool } from '../runtime/tools/findTool'
import { editTool } from '../runtime/tools/editTool'
import { writeTool } from '../runtime/tools/writeTool'
import { bashTool } from '../runtime/tools/bashTool'
import { shellSessionTool } from '../runtime/tools/shellSession'
import { setPersistentShellEnabled } from '../runtime/tools/bash'
import { processRegistry } from '../runtime/process'
import { loadNovaSettings } from '../runtime/settings/novaSettings'
import { archiveReadTool } from '../runtime/tools/archiveRead'
import { historyReadTool } from '../runtime/tools/historyRead'
import type { AgentEvent } from '../runtime/agent/types'
import type { NormalizedUsage } from '../shared/model/types'
import {
  deriveHeadlessSummary,
  accumulateRepairTotals,
  accumulateRepairOutcomes,
  type HeadlessTurnReport
} from './summary'
import { buildAtifTrajectory } from './atif'
import { parseArgs, type CliOptions } from './cliOptions'
import { headlessAssistantCompletionPolicy } from './completionPolicy'
import { PermissionManager } from '../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../runtime/permissions/PermissionService'
import {
  disabledHeadlessCodeGraphDiagnostics,
  startHeadlessCodeGraph,
  type HeadlessCodeGraphController
} from './codeGraph'
import type { CodeContextQueryPort } from '../runtime/code-graph/context'

interface UsageTotals {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

async function readInstruction(filePath?: string): Promise<string> {
  if (filePath) return readFileSync(filePath, 'utf8')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function createCodingTools(
  availability: ToolAvailability | null,
  codeContextQueryPort: CodeContextQueryPort | null
): Promise<ToolRegistry> {
  const registry = new ToolRegistry()
  registry.register(lsTool)
  registry.register(readTool)
  registry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  registry.register(findTool)
  if (codeContextQueryPort) {
    const { createCodeContextTool } = await import('../runtime/tools/codeContext')
    registry.register(createCodeContextTool({ getQueryPort: () => codeContextQueryPort }))
  }
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(bashTool)
  registry.register(shellSessionTool)
  registry.register(archiveReadTool)
  registry.register(historyReadTool)
  // 子集注册路径同样 fail closed：注册项必须已登记 Catalog
  const subsetCheck = validateRegisteredToolsAreCataloged(
    registry.getToolDefinitions().map(def => def.name)
  )
  if (!subsetCheck.ok) {
    throw new Error(
      `编码工具注册与 Tool Catalog 不一致：\n${subsetCheck.issues.map(i => `- ${i.detail}`).join('\n')}`
    )
  }
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

  // 跑分差异回溯的第一入口：先输出生效权限模式再进入任何执行路径
  process.stderr.write(`[nova-headless] permission-mode: ${options.permissionMode}\n`)

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
  let compactionCount = 0
  let toolResultBytes = 0
  let activeLoop: AgentLoop | null = null
  const deadlineAbortController = new AbortController()
  const deadlineTimer = options.deadlineSeconds === undefined
    ? undefined
    : setTimeout(() => {
        deadlineReached = true
        deadlineAbortController.abort()
        activeLoop?.cancel()
      }, options.deadlineSeconds * 1000)

  let codeGraphController: HeadlessCodeGraphController | null = null
  if (options.codeGraph === true) {
    codeGraphController = await startHeadlessCodeGraph({
      workspaceRoot: options.workdir,
      logsDir: options.logsDir,
      runtimeRoot: __dirname,
      abortSignal: deadlineAbortController.signal
    })
  }
  // headless 与桌面共用 runtime bash 工具：持久会话部署开关同样生效
  setPersistentShellEnabled(loadNovaSettings().persistentShellSessions)
  const registry = await createCodingTools(
    toolEconomyEnabled ? toolAvailability : null,
    codeGraphController?.queryPort ?? null
  )
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
  const contextWindow = options.contextWindow ?? resolveContextWindow(options.model)
  const stablePromptLayers = {
    agentRole: buildStableSystemPrompt({
      workingDir: options.workdir,
      surface: 'headless'
    }),
    baseRules: renderBaseRules(),
    projectRules: discoverProjectRules(options.workdir)?.text ?? '',
    modeInstruction: '',
    taskPolicy: taskPolicy.systemLayerText
  }
  const systemPromptLayers = {
    ...stablePromptLayers,
    toolSummary: renderModeToolInventory(
      'default',
      applyLedgerToolVisibility(definitions, 0),
      { dialect: 'native' }
    )
  }
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
  // 权限按显式 --permission-mode 生效并加载持久化规则；
  // headless 没有交互授权通道，需要批准的操作直接拒绝而不是挂死等待。
  const permissionManager = new PermissionManager()
  permissionManager.setRules(listPermissionRules(options.workdir))
  const loop = new AgentLoop(modelClient, eventBus, {
    systemPromptLayers,
    maxToolRounds: options.maxToolRounds,
    // 显式参数优先；缺省时由模型元数据解析（不再硬编码 1M，避免压缩阈值永不触发）
    contextWindow,
    supportsVision: false,
    permissionMode: options.permissionMode,
    permissionManager,
    permissionAskDeniedReason: 'headless 无交互授权通道，需要用户批准的操作已拒绝',
    toolExecution: 'parallel',
    maxParallelToolCalls: 4,
    onCompaction: () => {
      compactionCount += 1
    },
    onToolResultCommitted: (content) => {
      const serialized = typeof content === 'string' ? content : JSON.stringify(content)
      toolResultBytes += Buffer.byteLength(serialized, 'utf8')
    }
  })
  activeLoop = loop
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
  let report: HeadlessTurnReport
  try {
    if (deadlineReached) {
      report = { status: 'cancelled', deadlineReached: true }
    } else {
      const outcome = await loop.sendMessage(instruction, agentRoute())
      if (outcome.status === 'incomplete') {
        report = { status: 'incomplete', reason: outcome.reason, deadlineReached }
      } else if (outcome.status === 'failed') {
        report = { status: 'failed', deadlineReached }
        error = outcome.error.message
      } else {
        report = { status: outcome.status, deadlineReached }
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    report = { status: 'failed', deadlineReached }
  } finally {
    clearTimeout(deadlineTimer)
    activeLoop = null
    loop.dispose()
    // headless 无 will-quit，持久进程须在此统一终止
    await processRegistry.terminateAll()
    await codeGraphController?.close()
  }

  const summaryDerivation = deriveHeadlessSummary(report)

  const finishedAt = new Date()
  const atif = buildAtifTrajectory({
    instruction,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    events
  })
  const toolCallCounts = countToolCalls(
    atif.steps.flatMap((step) =>
      step.tool_calls?.map((call) => call.function_name) ?? []
    )
  )
  const cacheDiagnostic = loop.getCacheDiagnosticObservation()

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
    schema_version: 2,
    run_id: runId,
    evaluation: {
      case: options.evaluationCase ?? null,
      instruction_sha256: sha256(instruction),
      stable_prompt_sha256: sha256(JSON.stringify(stablePromptLayers)),
      provider_sha256: sha256(options.baseUrl),
      workspace_path_sha256: sha256(options.workdir),
      context_window: contextWindow
    },
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    permission_mode: options.permissionMode,
    proxy_transport: proxyTransport,
    max_tool_rounds: Number.isFinite(options.maxToolRounds)
      ? options.maxToolRounds
      : null,
    deadline_seconds: options.deadlineSeconds ?? null,
    deadline_reached: deadlineReached,
    status: report.status,
    budget_exhausted: summaryDerivation.budgetExhausted,
    failure_class: summaryDerivation.failureClass,
    error: error ?? null,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_seconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
    usage,
    tool_calls: atif.steps.reduce((sum, step) => sum + (step.tool_calls?.length ?? 0), 0),
    model_calls: atif.llmCallCount,
    tool_call_counts: {
      read: 0,
      grep: 0,
      find: 0,
      code_context: 0,
      ...toolCallCounts
    },
    tool_result_bytes: toolResultBytes,
    compaction_count: compactionCount,
    code_graph: codeGraphController?.getDiagnostics() ?? disabledHeadlessCodeGraphDiagnostics(),
    cache_diagnostics: {
      tools_bytes: cacheDiagnostic.toolsBytes,
      epoch_id: cacheDiagnostic.epochId,
      epoch_reason: cacheDiagnostic.epochReason,
      first_diff_part: cacheDiagnostic.firstDiffPart,
      first_diff_index: cacheDiagnostic.firstDiffIndex,
      estimated_invalidated_tokens: cacheDiagnostic.estimatedInvalidatedTokens,
      expected_reuse_tokens: cacheDiagnostic.expectedReuseTokens,
      actual_cache_read_tokens: cacheDiagnostic.actualCacheReadTokens
    },
    repair: accumulateRepairTotals(events),
    repair_outcome: accumulateRepairOutcomes(events),
    task_policy: {
      tier: taskPolicy.tier,
      matched_by: taskPolicy.matchedBy,
      tool_economy: toolEconomyEnabled
    },
    tool_economy: {
      ...toolAvailability.getDiagnostics(registry.getToolDefinitions()),
      // 纯额外模型步：该步的全部工具调用都是 load_tools（首次进入能力域的往返成本）
      load_tools_extra_model_steps: atif.steps.filter(
        step =>
          (step.tool_calls?.length ?? 0) > 0 &&
          step.tool_calls!.every(call => call.function_name === 'load_tools')
      ).length
    }
  }
  writeJson(summaryPath, summary)
  // 摘要是进程的最后输出：写完立即退出，不等待事件循环排空。
  // 任务可能遗留 nohup 后台进程继承工具管道等句柄，靠事件循环自然退出
  // 会永远挂住，把外部调用方（评测 harness）卡死。
  writeAndExit(process.stdout, `${JSON.stringify(summary)}\n`, summaryDerivation.exitNonZero ? 1 : 0)
}

function countToolCalls(names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

main().catch(error => {
  writeAndExit(process.stderr, `${error instanceof Error ? error.message : String(error)}\n`, 1)
})
