import * as path from 'node:path'
import type { CodeRelationResolver, CodeUnresolvedReason } from '../types'

export interface ResolvedModulePath {
  readonly kind: 'resolved'
  readonly path: string
  readonly resolver: CodeRelationResolver
}

export interface AmbiguousModulePath {
  readonly kind: 'ambiguous'
  readonly candidates: readonly string[]
  readonly reason: Extract<CodeUnresolvedReason, 'ambiguous_module'>
  readonly resolver: CodeRelationResolver
}

export interface UnresolvedModulePath {
  readonly kind: 'unresolved'
  readonly reason: Exclude<
    CodeUnresolvedReason,
    | 'ambiguous_module'
    | 'export_not_found'
    | 'ambiguous_export'
    | 'dynamic_dispatch'
    | 'same_file_target_ambiguous'
    | 'reexport_depth_exceeded'
    | 'shadowed_import_binding'
  >
  readonly resolver: CodeRelationResolver
}

export type ModulePathResolution =
  | ResolvedModulePath
  | AmbiguousModulePath
  | UnresolvedModulePath

export interface WorkspaceCandidateOptions {
  readonly extensions: readonly string[]
  readonly indexName?: string
  readonly explicitExtensionFallbacks?: ReadonlyMap<string, readonly string[]>
}

/** 只维护规范化文件集合；具体语言的模块规则由各自 Resolver 决定。 */
export class WorkspaceModuleFileIndex {
  private readonly files: ReadonlySet<string>

  constructor(workspaceFiles: readonly string[]) {
    this.files = new Set(workspaceFiles)
  }

  candidates(inputBase: string, options: WorkspaceCandidateOptions): string[] {
    const normalized = normalizeWorkspacePath(inputBase)
    if (!normalized) return []
    if (this.files.has(normalized)) return [normalized]

    const candidates = new Set<string>()
    const extension = path.posix.extname(normalized)
    if (!extension) {
      const indexName = options.indexName ?? 'index'
      for (const candidateExtension of options.extensions) {
        const fileCandidate = `${normalized}${candidateExtension}`
        if (this.files.has(fileCandidate)) candidates.add(fileCandidate)
        const indexCandidate = `${normalized}/${indexName}${candidateExtension}`
        if (this.files.has(indexCandidate)) candidates.add(indexCandidate)
      }
    } else {
      const withoutExtension = normalized.slice(0, -extension.length)
      for (const fallback of options.explicitExtensionFallbacks?.get(extension) ?? []) {
        const candidate = `${withoutExtension}${fallback}`
        if (this.files.has(candidate)) candidates.add(candidate)
      }
    }
    return [...candidates].sort((left, right) => left.localeCompare(right, 'en'))
  }
}

export function resolutionFromCandidates(
  candidates: readonly string[],
  resolver: CodeRelationResolver
): ModulePathResolution {
  const sorted = [...new Set(candidates)]
    .sort((left, right) => left.localeCompare(right, 'en'))
  const candidate = sorted[0]
  if (sorted.length === 1 && candidate) {
    return Object.freeze({ kind: 'resolved', path: candidate, resolver })
  }
  if (sorted.length > 1) {
    return Object.freeze({
      kind: 'ambiguous',
      candidates: Object.freeze(sorted),
      reason: 'ambiguous_module',
      resolver
    })
  }
  return Object.freeze({ kind: 'unresolved', reason: 'no_matching_file', resolver })
}

export function normalizeWorkspacePath(candidate: string): string | null {
  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'))
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return null
  }
  return normalized.replace(/^\.\//, '')
}
