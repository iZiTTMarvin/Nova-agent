import { join } from 'path'
import { AgentLoop, EventBus } from '../../../runtime/agent'
import { SystemPromptBuilder } from '../../../runtime/agent/promptBuilder/SystemPromptBuilder'
import type { ModelClient } from '../../../runtime/model/ModelClient'
import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import type { ToolExecutor } from '../../../runtime/tools/types'
import type { ReadState } from '../../../runtime/tools/editTool'
import { PermissionManager } from '../../../runtime/permissions/PermissionManager'
import { listPermissionRules } from '../../../runtime/permissions/PermissionService'
import { CheckpointManager } from '../../../runtime/checkpoints/CheckpointManager'
import { ArtifactStore } from '../../../runtime/artifacts/ArtifactStore'
import type { SessionStore } from '../../../runtime/sessions/SessionStore'
import {
  persistCompactionSnapshot,
  restoreOrInjectHistory
} from '../../../runtime/sessions/contextSnapshot'
import type { NovaSettings } from '../../../runtime/settings/novaSettings'
import type {
  PreparedSubagentTurn,
  PrepareSubagentTurnInput
} from '../../../runtime/subagents'
import { buildModelPoolWithFallbacks } from './AgentRuntimeFactory'

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是子代理，不要反问父 agent。'

export interface PrepareSubagentRuntimeInput extends PrepareSubagentTurnInput {
  readonly modelClient: ModelClient
  readonly resolveTool: (name: string) => ToolExecutor | undefined
  readonly sessionStore: SessionStore
  readonly sessionsDir: string
  readonly novaSettings: NovaSettings
  readonly readState: ReadState
  readonly contextWindow: number
  readonly supportsVision: boolean
  readonly promptCacheKey?: string
  readonly resolveImageUrl?: (url: string) => string
}

/** 为 Child Session 装配普通 AgentLoop；不创建 Session/Run，也不提交终态。 */
export function prepareSubagentRuntime(
  input: PrepareSubagentRuntimeInput
): PreparedSubagentTurn {
  const toolRegistry = new ToolRegistry()
  for (const toolName of input.profile.toolNames) {
    const tool = input.resolveTool(toolName)
    if (tool) toolRegistry.register(tool)
  }
  const toolSummary = toolRegistry
    .getToolDefinitions()
    .map((tool) => `- ${tool.name}: ${tool.description.split('\n')[0]}`)
    .join('\n')
  const systemPrompt = SystemPromptBuilder.build({
    agentRole: input.profile.systemPrompt,
    baseRules: BASE_RULES_MINIMAL,
    projectRules: null,
    skillContext: '',
    modeInstruction: 'You are a sub-agent. Be concise. Return a structured summary.',
    toolSummary
  })

  const eventBus = new EventBus()
  const permissionManager = new PermissionManager()
  permissionManager.setRules(listPermissionRules(input.workingDirectory))
  permissionManager.setCurrentProjectPath(input.workingDirectory)
  permissionManager.setSessionId(input.childSession.id)
  permissionManager.setPermissionPolicy(input.novaSettings.permissionPolicy)

  const modelPool = buildModelPoolWithFallbacks(input.modelClient)
  const agentLoop = new AgentLoop(modelPool, eventBus, {
    systemPrompt,
    maxToolRounds: input.profile.maxToolRounds,
    contextWindow: input.profile.contextWindow ?? input.contextWindow,
    supportsVision: input.supportsVision,
    toolExecution: 'sequential',
    ...(input.promptCacheKey ? { promptCacheKey: input.promptCacheKey } : {}),
    onCompaction: (compactedContext, meta) => {
      if (
        !persistCompactionSnapshot(
          input.sessionStore,
          input.childSession.id,
          compactedContext,
          meta
        )
      ) {
        console.error(
          `[SubagentRuntimeFactory] 找不到 Child Session ${input.childSession.id}，压缩快照未写`
        )
      }
    }
  })
  agentLoop.setWorkingDir(input.workingDirectory)
  agentLoop.setWorkspaceRoot(input.childSession.workspaceRoot)
  agentLoop.setToolRegistry(toolRegistry)
  agentLoop.setPermissionManager(permissionManager)
  agentLoop.setMode(
    input.profile.permissionCeiling === 'read_only' || input.isolation === 'readonly'
      ? 'plan'
      : 'default'
  )
  agentLoop.setSessionContext(input.sessionStore, input.childSession.id)
  agentLoop.setReadState(input.readState)
  agentLoop.setArtifactStore(new ArtifactStore(input.sessionsDir))
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
    input.sessionStore.loadContextSnapshot(input.childSession.id),
    input.resolveImageUrl
  )

  return { agentLoop, eventBus }
}
