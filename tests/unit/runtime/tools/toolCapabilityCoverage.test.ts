/**
 * 工具能力分类 / UI 显示名「全覆盖」回归守卫
 *
 * 背景：本仓库已两次踩同一类坑——新增工具后忘了在 `toolVisibility.getToolCapability`
 * 里登记分类，导致它落到 `unknown` → 权限层 `rules.ts` 把 unknown 一律当 bash 处理 →
 * default 模式下被误判为需要「执行前确认」：
 *   1. 2026-06-26：task / invoke_skill
 *   2. 2026-06-28：askQuestion
 * 同源的第二个症状是 UI 工具卡片标题落到兜底「运行自动化工具 (xxx)」。
 *
 * 本测试把 agentHandler 实际注册的全部内置工具注册进一个真实 ToolRegistry，
 * 遍历 `getToolDefinitions()`，对每个工具断言：
 *   - getToolCapability(name) !== 'unknown'（否则权限层会误当 bash 要求确认）
 *   - getToolDisplayName(name) 不落到兜底「运行自动化工具」（UI 标题必须有专属中文名）
 *
 * ⚠️ 维护约定：本文件的工具注册清单必须与 `src/main/ipc/agentHandler.ts` 中
 * `toolRegistry.register(...)` 的清单保持一致。新增工具时若忘了同步分类 / 显示名，
 * 本测试会直接变红，从而在 CI 阶段拦截而非等到线上误弹权限。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { lsTool } from '../../../../src/runtime/tools/lsTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { createGrepTool } from '../../../../src/runtime/tools/grepTool'
import { findTool } from '../../../../src/runtime/tools/findTool'
import { webSearchTool } from '../../../../src/runtime/tools/webSearch'
import { createMemorySearchTool } from '../../../../src/runtime/tools/memorySearch'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { editTool } from '../../../../src/runtime/tools/editTool'
import { writeTool } from '../../../../src/runtime/tools/writeTool'
import { bashTool } from '../../../../src/runtime/tools/bashTool'
import { todoWriteTool } from '../../../../src/runtime/tools/todoWriteTool'
import { askQuestionTool } from '../../../../src/runtime/tools/askQuestionTool'
import { createInvokeSkillTool } from '../../../../src/runtime/tools/invokeSkillTool'
import { createTaskTool } from '../../../../src/runtime/tools/taskTool'
import { getToolCapability } from '../../../../src/shared/session/toolVisibility'
import { getToolDisplayName } from '../../../../src/renderer/features/chat/toolDisplay'

/**
 * 构造一个注册了「全部内置工具」的 ToolRegistry，镜像 agentHandler 的注册清单。
 *
 * 三个工厂工具（grep / invoke_skill / task）的构造体不在创建时解引用依赖
 * （依赖只在 execute 内使用），因此用最小 mock 即可拿到工具对象与其 name。
 */
function buildFullRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // 静态工具（与 agentHandler 顺序一致）
  registry.register(lsTool)
  registry.register(readTool)
  registry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  registry.register(findTool)
  registry.register(webSearchTool)
  registry.register(createMemorySearchTool({
    getMemoryService: () => null,
    loadSettings: () => DEFAULT_NOVA_SETTINGS
  }))
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(bashTool)
  registry.register(todoWriteTool)
  registry.register(askQuestionTool)

  // 工厂工具：依赖仅在 execute 时使用，构造期传最小 mock 即可
  registry.register(createInvokeSkillTool({} as unknown as Parameters<typeof createInvokeSkillTool>[0]))
  registry.register(createTaskTool({} as unknown as Parameters<typeof createTaskTool>[0]))

  return registry
}

describe('工具能力分类 / 显示名全覆盖守卫', () => {
  const registry = buildFullRegistry()
  const toolNames = registry.getToolDefinitions().map(d => d.name)

  it('注册清单非空且包含已知关键工具（自检：防止注册函数静默失效）', () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(12)
    for (const expected of ['bash', 'askQuestion', 'task', 'invoke_skill', 'todo_write']) {
      expect(toolNames, `注册清单应包含 ${expected}`).toContain(expected)
    }
  })

  it('每个已注册工具都有明确能力分类（不得落到 unknown）', () => {
    const unclassified = toolNames.filter(name => getToolCapability(name) === 'unknown')
    expect(
      unclassified,
      `以下已注册工具未在 toolVisibility.getToolCapability 登记分类，会被权限层当作 bash 误弹确认：${unclassified.join(', ')}`
    ).toEqual([])
  })

  it('每个已注册工具都有专属 UI 显示名（不得落到兜底「运行自动化工具」）', () => {
    const fallback = toolNames.filter(name =>
      getToolDisplayName(name).startsWith('运行自动化工具')
    )
    expect(
      fallback,
      `以下已注册工具缺少 toolDisplay.getToolDisplayName 映射，UI 标题会显示成兜底文案：${fallback.join(', ')}`
    ).toEqual([])
  })
})
