/**
 * Catalog 清洁度校验：注册清单与 Catalog 双向对账，fail closed。
 * CI 覆盖测试与装配期自检共用同一判定。
 */
import {
  getDeferredGroupMeta,
  listCatalogEntries,
  listDefinedGroupIds,
  listGroupToolNames
} from './ToolCatalog'

export interface CatalogValidationIssue {
  readonly kind:
    | 'unregistered-product-tool'
    | 'missing-catalog-entry'
    | 'deferred-without-group'
    | 'group-without-member-entry'
    | 'empty-live-group'
    | 'duplicate-name'
  readonly detail: string
}

export interface CatalogValidationResult {
  readonly ok: boolean
  readonly issues: readonly CatalogValidationIssue[]
}

/** Catalog 自身结构完整性（deferred 必须带组合法组 id，组必须能从条目推导出成员） */
export function validateCatalogIntegrity(): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = []
  const seen = new Set<string>()

  for (const entry of listCatalogEntries()) {
    if (seen.has(entry.name)) {
      issues.push({ kind: 'duplicate-name', detail: `工具 "${entry.name}" 在 Catalog 中重复登记` })
    }
    seen.add(entry.name)

    if (entry.exposure === 'deferred') {
      if (!entry.groupId) {
        issues.push({
          kind: 'deferred-without-group',
          detail: `deferred 工具 "${entry.name}" 缺少 groupId`
        })
      } else if (!getDeferredGroupMeta(entry.groupId)) {
        issues.push({
          kind: 'deferred-without-group',
          detail: `deferred 工具 "${entry.name}" 引用了未定义组 "${entry.groupId}"`
        })
      }
    }
  }

  for (const groupId of listDefinedGroupIds()) {
    const meta = getDeferredGroupMeta(groupId)
    if (!meta) continue
    const members = listGroupToolNames(groupId)
    if (!meta.reserved && members.length === 0) {
      issues.push({
        kind: 'group-without-member-entry',
        detail: `非 reserved 组 "${groupId}" 没有任何成员条目`
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

/**
 * 子集注册路径（如 headless 编码工具集）的 fail-closed 校验：
 * 只要求注册项全部在 Catalog 中，不要求 Catalog 全部注册。
 */
export function validateRegisteredToolsAreCataloged(
  registeredToolNames: Iterable<string>
): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = []
  const catalogNames = new Set(listCatalogEntries().map(entry => entry.name))
  for (const name of registeredToolNames) {
    if (!catalogNames.has(name)) {
      issues.push({
        kind: 'missing-catalog-entry',
        detail: `工具 "${name}" 已注册但未登记进 Tool Catalog；请在 catalog/ToolCatalog.ts 补充条目`
      })
    }
  }
  return { ok: issues.length === 0, issues }
}

/**
 * 校验一份实际注册的工具名清单与 Catalog 的一致性：
 * - 注册工具必须在 Catalog 中（未登记 → fail closed，禁止静默成为 core）；
 * - Catalog 中 registration=always 的条目必须已注册（防注册清单静默丢工具）；
 * - 非 reserved 组至少有一个成员已注册（空组只允许显式 reserved）。
 */
export function validateRegistryAgainstCatalog(
  registeredToolNames: Iterable<string>
): CatalogValidationResult {
  const registered = [...registeredToolNames]
  const registeredSet = new Set(registered)
  const issues: CatalogValidationIssue[] = []

  if (registered.length !== registeredSet.size) {
    issues.push({ kind: 'duplicate-name', detail: '注册清单存在重复工具名' })
  }

  for (const name of registeredSet) {
    const entry = listCatalogEntries().find(e => e.name === name)
    if (!entry) {
      issues.push({
        kind: 'missing-catalog-entry',
        detail: `工具 "${name}" 已注册但未登记进 Tool Catalog；请在 catalog/ToolCatalog.ts 补充条目`
      })
    }
  }

  for (const entry of listCatalogEntries()) {
    if (entry.registration === 'conditional') continue
    if (!registeredSet.has(entry.name)) {
      issues.push({
        kind: 'unregistered-product-tool',
        detail: `Catalog 工具 "${entry.name}" 未出现在注册清单中`
      })
    }
  }

  for (const groupId of listDefinedGroupIds()) {
    const meta = getDeferredGroupMeta(groupId)
    if (!meta || meta.reserved) continue
    const members = listGroupToolNames(groupId)
    if (!members.some(name => registeredSet.has(name))) {
      issues.push({
        kind: 'empty-live-group',
        detail: `live 组 "${groupId}" 的成员（${members.join(', ')}）均未注册`
      })
    }
  }

  return { ok: issues.length === 0, issues }
}
