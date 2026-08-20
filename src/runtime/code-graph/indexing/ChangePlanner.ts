import type { WorkspaceChange } from './WorkspaceChangeSource'

export const CODE_INDEX_CHANGE_DEBOUNCE_MS = 250
export const CODE_INDEX_BULK_CHANGE_COUNT = 200
export const CODE_INDEX_BULK_CHANGE_RATIO = 0.2

export type CodeIndexChangePlan =
  | {
      readonly kind: 'incremental'
      readonly changes: readonly WorkspaceChange[]
    }
  | {
      readonly kind: 'full-rebuild'
      readonly reason: 'config-change' | 'bulk-change'
      readonly changes: readonly WorkspaceChange[]
    }

export function mergeWorkspaceChanges(
  changes: readonly WorkspaceChange[]
): readonly WorkspaceChange[] {
  const byPath = new Map<string, WorkspaceChange>()
  for (const change of changes) {
    const previous = byPath.get(change.path)
    if (!previous || changePriority(change.type) > changePriority(previous.type)) {
      byPath.set(change.path, Object.freeze({ ...change }))
    }
  }
  return Object.freeze(
    [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
  )
}

export function planWorkspaceChanges(
  changes: readonly WorkspaceChange[],
  indexedFileCount: number
): CodeIndexChangePlan {
  if (!Number.isInteger(indexedFileCount) || indexedFileCount < 0) {
    throw new Error('已索引文件数量必须是非负整数')
  }
  const merged = mergeWorkspaceChanges(changes)
  if (merged.some((change) => isExpandedInvalidationPath(change.path))) {
    return Object.freeze({ kind: 'full-rebuild', reason: 'config-change', changes: merged })
  }
  if (shouldUseFullRebuild(merged.length, indexedFileCount)) {
    return Object.freeze({ kind: 'full-rebuild', reason: 'bulk-change', changes: merged })
  }
  return Object.freeze({ kind: 'incremental', changes: merged })
}

export function shouldUseFullRebuild(
  changeCount: number,
  indexedFileCount: number
): boolean {
  if (!Number.isInteger(changeCount) || changeCount < 0) {
    throw new Error('变更数量必须是非负整数')
  }
  if (!Number.isInteger(indexedFileCount) || indexedFileCount < 0) {
    throw new Error('已索引文件数量必须是非负整数')
  }
  if (changeCount >= CODE_INDEX_BULK_CHANGE_COUNT) return true
  return indexedFileCount > 0 && changeCount / indexedFileCount >= CODE_INDEX_BULK_CHANGE_RATIO
}

export function isExpandedInvalidationPath(filePath: string): boolean {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase()
  return /^tsconfig.*\.json$/.test(name) ||
    name === 'jsconfig.json' ||
    name === 'package.json' ||
    name === 'package-lock.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === 'pyproject.toml' ||
    name === '.gitignore'
}

function changePriority(type: WorkspaceChange['type']): number {
  if (type === 'unlink') return 3
  return type === 'change' ? 2 : 1
}
