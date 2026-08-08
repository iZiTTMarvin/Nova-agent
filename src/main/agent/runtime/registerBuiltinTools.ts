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
import { createTaskTool } from '../../../runtime/tools/task'
import { savePlanTool } from '../../../runtime/tools/savePlan'
import { switchModeTool } from '../../../runtime/tools/switchMode'
import { stageTransitionTool } from '../../../runtime/tools/stageTransition'
import { archiveReadTool } from '../../../runtime/tools/archiveRead'
import { createStartWorkflowTool } from '../../../runtime/tools/startWorkflow'
import { createLoadToolsTool } from '../../../runtime/tools/loadTools'
import type { ToolAvailability } from '../../../runtime/tools/availability'
import type { WorkflowOrchestrator } from '../../../runtime/workflow'
import type { AgentLoop } from '../../../runtime/agent'
import type { SkillRegistry } from '../../../runtime/skills/SkillRegistry'
import type { MemoryService } from '../../../runtime/memory/MemoryService'
import type { NovaSettings } from '../../../runtime/settings/novaSettings'
import type { SpawnSubagentPort } from '../../../runtime/subagents'

export interface BuiltinToolRegistrationDeps {
  skillRegistry: SkillRegistry
  /** invoke_skill 执行时惰性读取；工具创建可早于 AgentLoop */
  getAgentLoop: () => AgentLoop | null
  getMemoryService: () => MemoryService | null
  loadSettings: () => NovaSettings
  /** 惰性获取主进程唯一编排器，工具执行时才读取。 */
  getWorkflowOrchestrator?: () => WorkflowOrchestrator | undefined
  /** task 工具执行时惰性解析本 turn 的统一 spawn 端口。 */
  getSpawnSubagentPort?: () => SpawnSubagentPort | undefined
  /** load_tools 写入的会话级工具可用性 Owner */
  getToolAvailability?: () => ToolAvailability | null
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
  toolRegistry.register(archiveReadTool)
  toolRegistry.register(
    createLoadToolsTool({
      getAvailability: deps.getToolAvailability ?? (() => null)
    })
  )
  toolRegistry.register(todoWriteTool)
  toolRegistry.register(askQuestionTool)
  toolRegistry.register(savePlanTool)
  toolRegistry.register(switchModeTool)
  toolRegistry.register(stageTransitionTool)
  toolRegistry.register(
    createStartWorkflowTool({
      getOrchestrator: deps.getWorkflowOrchestrator ?? (() => undefined),
      getSpawnSubagentPort: deps.getSpawnSubagentPort ?? (() => undefined)
    })
  )
  toolRegistry.register(
    createInvokeSkillTool({
      skillRegistry: deps.skillRegistry,
      getSpawnSubagentPort: deps.getSpawnSubagentPort ?? (() => undefined),
      onSkillInvoked: (skill) => {
        deps.getAgentLoop()?.addSkillRoot(skill.directory)
      }
    })
  )
  toolRegistry.register(
    createTaskTool({
      getSpawnSubagentPort: deps.getSpawnSubagentPort ?? (() => undefined)
    })
  )
}
