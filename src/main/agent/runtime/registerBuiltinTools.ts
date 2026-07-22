/**
 * 内置工具注册清单（与 AgentRuntimeFactory 共用，避免测试与装配漂移）。
 */
import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { lsTool } from '../../../runtime/tools/lsTool'
import { readTool } from '../../../runtime/tools/readTool'
import { createGrepTool } from '../../../runtime/tools/grepTool'
import { findTool } from '../../../runtime/tools/findTool'
import { webSearchTool } from '../../../runtime/tools/webSearch'
import { createMemorySearchTool } from '../../../runtime/tools/memorySearch'
import { editTool } from '../../../runtime/tools/editTool'
import { writeTool } from '../../../runtime/tools/writeTool'
import { bashTool } from '../../../runtime/tools/bashTool'
import { todoWriteTool } from '../../../runtime/tools/todoWriteTool'
import { askQuestionTool } from '../../../runtime/tools/askQuestionTool'
import { createInvokeSkillTool } from '../../../runtime/tools/invokeSkillTool'
import { createTaskTool } from '../../../runtime/tools/taskTool'
import type { AgentLoop, EventBus } from '../../../runtime/agent'
import type { ModelClient } from '../../../runtime/model/ModelClient'
import type { SkillRegistry } from '../../../runtime/skills/SkillRegistry'
import type { MemoryService } from '../../../runtime/memory/MemoryService'
import type { NovaSettings } from '../../../runtime/settings/novaSettings'
import type { SubAgentPermissionBridge } from '../../../runtime/tools/subAgentBridge'

export interface BuiltinToolRegistrationDeps {
  modelClient: ModelClient
  skillRegistry: SkillRegistry
  eventBus: EventBus
  contextWindow: number
  supportsVision: boolean
  useUnifiedSkillDispatch: boolean
  /** invoke_skill 执行时惰性读取；工具创建可早于 AgentLoop */
  getAgentLoop: () => AgentLoop | null
  getMemoryService: () => MemoryService | null
  loadSettings: () => NovaSettings
  /**
   * 惰性获取本 run 的子代理权限桥接（按当前 runId 解析）。
   * 装配时 runId 可能尚未分配，故延迟到执行期读取。
   */
  getPermissionBridge?: () => SubAgentPermissionBridge
}

/**
 * 注册全部内置工具。新增工具时除了在此 register，还必须：
 * (1) 在 shared/session/toolVisibility.getToolCapability 登记能力分类；
 * (2) 在 renderer toolDisplay 补显示名。
 * 回归守卫见 tests/unit/runtime/tools/toolCapabilityCoverage.test.ts。
 */
export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  deps: BuiltinToolRegistrationDeps
): void {
  toolRegistry.register(lsTool)
  toolRegistry.register(readTool)
  toolRegistry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  toolRegistry.register(findTool)
  toolRegistry.register(webSearchTool)
  toolRegistry.register(
    createMemorySearchTool({
      getMemoryService: deps.getMemoryService,
      loadSettings: deps.loadSettings
    })
  )
  toolRegistry.register(editTool)
  toolRegistry.register(writeTool)
  toolRegistry.register(bashTool)
  toolRegistry.register(todoWriteTool)
  toolRegistry.register(askQuestionTool)
  toolRegistry.register(
    createInvokeSkillTool({
      modelClient: deps.modelClient,
      skillRegistry: deps.skillRegistry,
      useUnifiedSkillDispatch: deps.useUnifiedSkillDispatch,
      parentEventBus: deps.eventBus,
      resolveTool: (name) => toolRegistry.getTool(name),
      contextWindow: deps.contextWindow,
      supportsVision: deps.supportsVision,
      onSkillInvoked: (skill) => {
        deps.getAgentLoop()?.addSkillRoot(skill.directory)
      }
    })
  )
  toolRegistry.register(
    createTaskTool({
      modelClient: deps.modelClient,
      parentEventBus: deps.eventBus,
      contextWindow: deps.contextWindow,
      supportsVision: deps.supportsVision,
      resolveTool: (name) => toolRegistry.getTool(name),
      ...(deps.getPermissionBridge ? { getPermissionBridge: deps.getPermissionBridge } : {})
    })
  )
}
