/**
 * Tool Catalog 清洁度守卫：注册清单与 Catalog 双向对账，fail closed。
 * 防两类真实回归：
 * - 新增工具忘记登记 Catalog → 未分组 fail-open（自动变 core）或隐藏行为不可预期；
 * - Catalog 行被误删 → 注册工具失去可用性策略来源。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { SkillRegistry } from '../../../../src/runtime/skills/SkillRegistry'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { registerBuiltinTools } from '../../../../src/main/agent/runtime/registerBuiltinTools'
import type { BuiltinToolRegistrationDeps } from '../../../../src/main/agent/runtime/registerBuiltinTools'
import {
  buildLoadToolsDescription,
  getCatalogEntry,
  isLoadableToolGroup,
  listCatalogEntries,
  listDefinedGroupIds,
  listLiveDeferredGroupIds,
  normalizeGroupAlias,
  validateCatalogIntegrity,
  validateRegistryAgainstCatalog
} from '../../../../src/runtime/tools/catalog'
import { getToolCapability } from '../../../../src/shared/session/toolVisibility'

function buildRegistry(overrides: Partial<BuiltinToolRegistrationDeps> = {}): ToolRegistry {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, {
    skillRegistry: {} as SkillRegistry,
    getAgentLoop: () => null,
    getMemoryRetrievalService: () => null,
    loadSettings: () => DEFAULT_NOVA_SETTINGS,
    memoryEnabled: true,
    ...overrides
  })
  return registry
}

const fullRegistryNames = (): string[] =>
  buildRegistry().getToolDefinitions().map(def => def.name)

describe('Tool Catalog 清洁度', () => {
  it('Catalog 自身结构完整：无重复名、deferred 均带合法组、live 组均有成员条目', () => {
    const result = validateCatalogIntegrity()
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('全部内置注册工具都进入 Catalog（内存开启与关闭两种注册清单）', () => {
    for (const memoryEnabled of [true, false]) {
      const names = buildRegistry({ memoryEnabled })
        .getToolDefinitions()
        .map(def => def.name)
      const result = validateRegistryAgainstCatalog(names)
      expect(
        result.issues.filter(issue => issue.kind === 'missing-catalog-entry'),
        `memoryEnabled=${memoryEnabled}`
      ).toEqual([])
    }
  })

  it('注册一个未登记 Catalog 的工具 → 校验 fail closed，而非静默成为 core', () => {
    const result = validateRegistryAgainstCatalog([...fullRegistryNames(), 'mystery_tool'])
    expect(result.ok).toBe(false)
    expect(result.issues.some(issue => issue.kind === 'missing-catalog-entry')).toBe(true)
  })

  it('Catalog 中任一 always 工具从注册清单消失 → 校验失败（防注册清单静默丢工具）', () => {
    const result = validateRegistryAgainstCatalog(
      fullRegistryNames().filter(name => name !== 'edit')
    )
    expect(result.ok).toBe(false)
    expect(
      result.issues.some(
        issue => issue.kind === 'unregistered-product-tool' && issue.detail.includes('edit')
      )
    ).toBe(true)
  })

  it('memory_search 为 conditional 注册：缺席注册清单不构成违规', () => {
    const withoutMemory = fullRegistryNames().filter(name => name !== 'memory_search')
    const result = validateRegistryAgainstCatalog(withoutMemory)
    expect(result.ok).toBe(true)
  })

  it('live 组成员全部未注册 → 校验失败（空组绝不下发）', () => {
    const result = validateRegistryAgainstCatalog(
      fullRegistryNames().filter(name => name !== 'task')
    )
    expect(result.ok).toBe(false)
    expect(result.issues.some(issue => issue.kind === 'empty-live-group')).toBe(true)
  })
})

describe('Deferred 组暴露规则', () => {
  it('browser / computer-use 为预留空组：不进入 live 组、不接受 load_tools', () => {
    const live = listLiveDeferredGroupIds(fullRegistryNames())
    expect(live).toEqual(['agent'])
    expect(live).not.toContain('browser')
    expect(live).not.toContain('computer-use')
    expect(isLoadableToolGroup('browser')).toBe(false)
    expect(isLoadableToolGroup('computer-use')).toBe(false)
    expect(isLoadableToolGroup('agent')).toBe(true)
  })

  it('历史 orchestration 只作为恢复 alias，不进入组定义与 live enum', () => {
    expect(listDefinedGroupIds()).not.toContain('orchestration')
    expect(normalizeGroupAlias('orchestration')).toBe('agent')
    expect(normalizeGroupAlias('agent')).toBe('agent')
  })

  it('load_tools 描述字节级稳定：不含激活状态，只列 live 组', () => {
    const first = buildLoadToolsDescription(['agent'])
    const second = buildLoadToolsDescription(['agent'])
    expect(first).toBe(second)
    expect(first).toContain('- agent:')
    expect(first).not.toContain('activated')
    expect(first).not.toContain('browser')
    expect(first).not.toContain('reserved')
  })

  it('高频 Coding 工具全部为 always 暴露，不进入 deferred', () => {
    const alwaysTools = [
      'ls',
      'read',
      'grep',
      'find',
      'edit',
      'write',
      'bash',
      'todo_write',
      'askQuestion',
      'archive_read',
      'web_search',
      'memory_search',
      'invoke_skill'
    ]
    for (const name of alwaysTools) {
      const entry = getCatalogEntry(name)
      expect(entry, `${name} 必须登记 Catalog`).not.toBeNull()
      expect(entry?.exposure, `${name} 应保持 always 暴露`).toBe('always')
    }
  })

  it('mode-bound 工具与 load_tools 元数据齐全', () => {
    for (const name of ['save_plan', 'switch_mode', 'stage_transition']) {
      expect(getCatalogEntry(name)?.exposure).toBe('mode-bound')
    }
    expect(getCatalogEntry('load_tools')?.exposure).toBe('internal')
    expect(getCatalogEntry('load_tools')?.codeMode).toBe('direct-only')
  })

  it('Catalog capability 与 shared 权限分类对齐（两组映射不得漂移）', () => {
    // shared/session/toolVisibility 是权限层的分类真源（shared 不得依赖 runtime），
    // 此处以 CI 断言保持 Catalog capability 与其一致
    const readonlyCapabilities = new Set(['filesystem-read', 'web', 'archive', 'memory'])
    for (const entry of listCatalogEntries()) {
      if (entry.name === 'load_tools') continue
      const sharedCapability = getToolCapability(entry.name)
      expect(sharedCapability, `${entry.name} 未在 shared toolVisibility 登记分类`).not.toBe('unknown')
      if (readonlyCapabilities.has(entry.capability)) {
        expect(
          sharedCapability,
          `${entry.capability} 类工具 ${entry.name} 在 shared 中应为 readonly`
        ).toBe('readonly')
      }
    }
  })
})
