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
import { createLoadToolsTool } from '../../../runtime/tools/loadTools'
import { validateRegistryAgainstCatalog } from '../../../runtime/tools/catalog'
import type { ToolAvailability } from '../../../runtime/tools/availability'
import type { AgentLoop } from '../../../runtime/agent'
import type { SkillRegistry } from '../../../runtime/skills/SkillRegistry'
import type { MemoryRetrievalService } from '../../../runtime/memory/retrieval/MemoryRetrievalService'
import type { NovaSettings } from '../../../runtime/settings/novaSettings'
import type { SpawnSubagentPort } from '../../../runtime/subagents'

export interface BuiltinToolRegistrationDeps {
  skillRegistry: SkillRegistry
  /** invoke_skill 执行时惰性读取；工具创建可早于 AgentLoop */
  getAgentLoop: () => AgentLoop | null
  getMemoryRetrievalService: () => MemoryRetrievalService | null
  loadSettings: () => NovaSettings
  /** task 工具执行时惰性解析本 turn 的统一 spawn 端口。 */
  getSpawnSubagentPort?: () => SpawnSubagentPort | undefined
  /** load_tools 写入的会话级工具可用性 Owner */
  getToolAvailability?: () => ToolAvailability | null
  /**
   * 是否注册 memory_search。由装配方按本轮设置快照决定（与 memoryContext /
   * prefetch 接线同源）；每轮装配重新注册，开关变化下一轮即生效。
   */
  memoryEnabled: boolean
}

/**
 * 注册全部内置工具。新增工具时除了在此 register，还必须：
 * (1) 在 runtime/tools/catalog/ToolCatalog.ts 登记 Catalog 条目；
 * (2) 在 shared/session/toolVisibility.getToolCapability 登记能力分类；
 * (3) 在 renderer toolDisplay 补显示名。
 * 回归守卫见 tests/unit/runtime/tools/toolCatalog.test.ts 与 toolCapabilityCoverage.test.ts。
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
  if (deps.memoryEnabled) {
    toolRegistry.register(
      createMemorySearchTool({
        getMemoryRetrievalService: deps.getMemoryRetrievalService,
        loadSettings: deps.loadSettings
      })
    )
  }
  toolRegistry.register(editTool)
  toolRegistry.register(writeTool)
  toolRegistry.register(bashTool)
  toolRegistry.register(archiveReadTool)
  toolRegistry.register(todoWriteTool)
  toolRegistry.register(askQuestionTool)
  toolRegistry.register(savePlanTool)
  toolRegistry.register(switchModeTool)
  toolRegistry.register(stageTransitionTool)
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
  // load_tools 最后注册：其 enum / 描述需要完整注册清单来判定 live deferred 组
  toolRegistry.register(
    createLoadToolsTool({
      getAvailability: deps.getToolAvailability ?? (() => null),
      registeredToolNames: toolRegistry.getToolDefinitions().map(def => def.name)
    })
  )

  // 清洁度 fail closed：注册清单与 Catalog 双向对账，未登记工具不得静默成为 core
  const catalogCheck = validateRegistryAgainstCatalog(
    toolRegistry.getToolDefinitions().map(def => def.name)
  )
  if (!catalogCheck.ok) {
    throw new Error(
      `内置工具注册与 Tool Catalog 不一致：\n${catalogCheck.issues.map(i => `- ${i.kind}: ${i.detail}`).join('\n')}`
    )
  }
}
