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
 * 本测试把 AgentRuntimeFactory 实际注册的全部内置工具注册进一个真实 ToolRegistry，
 * 遍历 `getToolDefinitions()`，对每个工具断言：
 *   - getToolCapability(name) !== 'unknown'（否则权限层会误当 bash 要求确认）
 *   - getToolDisplayName(name) 不落到兜底「运行自动化工具」（UI 标题必须有专属中文名）
 *
 * ⚠️ 维护约定：本文件通过 `registerBuiltinTools`
 *（`src/main/agent/runtime/registerBuiltinTools.ts`，由 AgentRuntimeFactory 调用）
 * 共用注册清单。新增工具时若忘了同步分类 / 显示名，本测试会直接变红。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { EventBus } from '../../../../src/runtime/agent'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { registerBuiltinTools } from '../../../../src/main/agent/runtime/registerBuiltinTools'
import { getToolCapability } from '../../../../src/shared/session/toolVisibility'
import { getToolDisplayName } from '../../../../src/renderer/features/chat/toolDisplay'

/**
 * 构造一个注册了「全部内置工具」的 ToolRegistry，镜像 AgentRuntimeFactory 的注册清单。
 * memory / invoke_skill / task 的构造体不在创建时解引用依赖，因此用最小 mock 即可。
 */
function buildFullRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, {
    modelClient: {} as ModelClient,
    skillRegistry: {} as SkillRegistry,
    eventBus: new EventBus(),
    contextWindow: 128_000,
    supportsVision: false,
    useUnifiedSkillDispatch: true,
    getAgentLoop: () => null,
    getMemoryService: () => null,
    loadSettings: () => DEFAULT_NOVA_SETTINGS
  })
  return registry
}

describe('工具能力分类 / 显示名全覆盖守卫', () => {
  const registry = buildFullRegistry()
  const toolNames = registry.getToolDefinitions().map(d => d.name)

  it('注册清单非空且包含已知关键工具（自检：防止注册函数静默失效）', () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(12)
    for (const expected of [
      'bash',
      'askQuestion',
      'task',
      'invoke_skill',
      'todo_write',
      'save_plan',
      'switch_mode'
    ]) {
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
