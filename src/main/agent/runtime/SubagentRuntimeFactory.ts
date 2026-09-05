import { join } from 'path'
import {
  AgentLoop,
  EventBus,
  projectEffectiveToolDefinitions,
  applyLedgerToolVisibility,
  renderMinimalEngineeringPolicy
} from '../../../runtime/agent'

import { OpenAICompatibleModelClient } from '../../../runtime/model/OpenAICompatibleModelClient'
import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { ModelClientPool } from '../../../runtime/model/ModelClientPool'
import type { ToolExecutor } from '../../../runtime/tools/types'
import type { ReadState } from '../../../runtime/tools/editTool'
import { PermissionManager } from '../../../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../../../runtime/permissions/PermissionService'
import {
  CheckpointManager,
  collectTouchedFilesForSession
} from '../../../runtime/checkpoints'
import { ArtifactStore } from '../../../runtime/artifacts/ArtifactStore'
import type { SessionStore } from '../../../runtime/sessions'
import {
  restoreOrInjectHistory
} from '../../../runtime/sessions/contextSnapshot'
import type {
  PreparedSubagentTurn,
  PrepareSubagentTurnInput
} from '../../../runtime/subagents'
import type { ToolAuthorizationPolicy } from '../../../runtime/permissions/PermissionCoordinator'
import type { LlmRegistry } from '../../../shared/config'
import { resolveChildModelFromHeader } from '../subagents/childModelRouting'

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是子代理，不要反问父 agent。'

export interface PrepareSubagentRuntimeInput extends PrepareSubagentTurnInput {
  readonly registry: LlmRegistry
  readonly resolveTool: (name: string) => ToolExecutor | undefined
  readonly sessionStore: SessionStore
  readonly sessionsDir: string
  readonly readState: ReadState
  readonly promptCacheKey?: string
  readonly resolveImageUrl?: (url: string) => string
  /** 父会话的阶段工具门禁（compose）；子代理继承，只能收窄。 */
  readonly toolAuthorizationPolicy?: ToolAuthorizationPolicy | null
}

/** profile 与调用隔离任一要求只读时，生效能力只能收窄。 */
function resolveReadonlyCeiling(input: PrepareSubagentRuntimeInput): boolean {
  return input.profile.permissionCeiling === 'read_only' || input.isolation === 'readonly'
}

/** 为 Child Session 装配普通 AgentLoop；不创建 Session/Run，也不提交终态。 */
export function prepareSubagentRuntime(
  input: PrepareSubagentRuntimeInput
): PreparedSubagentTurn {
  const isReadonly = resolveReadonlyCeiling(input)
  const ledger = input.sessionStore.loadContextSnapshot(input.childSession.id)
  const toolRegistry = new ToolRegistry()
  for (const toolName of input.profile.toolNames) {
    const tool = input.resolveTool(toolName)
    if (tool) toolRegistry.register(tool)
  }
  const capabilityCeiling = isReadonly ? 'read_only' as const : null
  const visibleToolDefinitions = applyLedgerToolVisibility(
    projectEffectiveToolDefinitions(
      input.childSession.mode,
      toolRegistry.getToolDefinitions(),
      null,
      'direct',
      capabilityCeiling
    ),
    ledger?.entries.length ?? 0
  )
  const toolSummaryRenderer = (definitions: typeof visibleToolDefinitions) => definitions
    .map((tool) => `- ${tool.name}: ${tool.description.split('\n')[0]}`)
    .join('\n')
  const systemPromptLayers = {
    agentRole: input.profile.systemPrompt,
    baseRules: BASE_RULES_MINIMAL,
    projectRules: null,
    skillContext: '',
    modeInstruction: 'You are a sub-agent. Be concise. Return a structured summary.',
    taskPolicy: renderMinimalEngineeringPolicy(),
    toolSummary: toolSummaryRenderer(visibleToolDefinitions)
  }

  const eventBus = new EventBus()
  const permissionManager = new PermissionManager()
  permissionManager.setRules(listPermissionRules(input.workingDirectory))

  const childHeader = input.childSession.subagent.header
  if (!childHeader) {
    throw new Error('Child Session 缺少模型 header，无法准备执行')
  }
  const childModel = resolveChildModelFromHeader(input.registry, childHeader)
  const modelClient = new OpenAICompatibleModelClient(childModel.modelConfig)
  const modelPool = new ModelClientPool({
    primary: modelClient,
    primaryConfig: childModel.modelConfig
  })
  const contextWindow = Math.min(
    input.profile.contextWindow ?? childModel.contextWindow,
    childModel.contextWindow
  )
  const agentLoop = new AgentLoop(modelPool, eventBus, {
    systemPromptLayers,
    toolSummaryRenderer,
    maxToolRounds: input.profile.maxToolRounds,
    contextWindow,
    supportsVision: childModel.supportsVision,
    toolExecution: 'sequential',
    // 停止通知的读者是父代理而非人类，不携带「发送继续」「设置」类指引
    stopNoticeAudience: 'subagent',
    permissionMode: input.childSession.permissionMode,
    ...(capabilityCeiling ? { permissionCeiling: capabilityCeiling } : {}),
    permissionManager,
    ...(input.promptCacheKey ? { promptCacheKey: input.promptCacheKey } : {}),
    collectCompactionTouchedFiles: messageIds =>
      collectTouchedFilesForSession(
        input.sessionsDir,
        input.childSession.id,
        messageIds
      )
  })
  agentLoop.setWorkingDir(input.workingDirectory)
  agentLoop.setWorkspaceRoot(input.childSession.workspaceRoot)
  agentLoop.setToolRegistry(toolRegistry)
  agentLoop.setMode(input.childSession.mode)
  // compose 阶段门禁 overlay 随父会话继承：子代理能力只能比父会话更窄。
  if (input.toolAuthorizationPolicy) {
    agentLoop.setToolAuthorizationPolicy(input.toolAuthorizationPolicy)
  }
  // 子代理不执行主会话的 Plan / Compose 产品流程，避免注入不适用的模式指令。
  agentLoop.setModeInstructionProvider(() => '')
  agentLoop.setSessionContext(input.sessionStore, input.childSession.id, { resolveImageUrl: input.resolveImageUrl })
  agentLoop.setReadState(input.readState)
  agentLoop.setArtifactStore(new ArtifactStore(input.sessionsDir))
  for (const skillRoot of input.profile.skillRoots ?? []) {
    agentLoop.addSkillRoot(skillRoot)
  }
  agentLoop.setBashEnvironment({
    binDirs: [join(input.workingDirectory, 'node_modules', '.bin')]
  })
  agentLoop.setCheckpointManager(
    new CheckpointManager({
      checkpointDir: input.sessionsDir,
      sessionId: input.childSession.id,
      workspaceRoot: input.workingDirectory,
      getActivePathMessageIds: () => {
        const session = input.sessionStore.load(input.childSession.id)
        return session
          ? new Set(session.messages.map((message) => message.id))
          : undefined
      }
    })
  )
  restoreOrInjectHistory(
    agentLoop,
    input.childSession,
    ledger,
    {
      ...(input.resolveImageUrl ? { resolveImageUrl: input.resolveImageUrl } : {}),
      sessionStore: input.sessionStore
    }
  )

  return { agentLoop, eventBus }
}
