import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { canonicalizeExistingPath, isPathWithinRoot } from '../../permissions/pathAccess'
import type { CodeRelationResolver } from '../types'
import {
  WorkspaceModuleFileIndex,
  normalizeWorkspacePath,
  resolutionFromCandidates,
  type ModulePathResolution,
  type UnresolvedModulePath
} from './WorkspaceModuleFileIndex'

export type {
  AmbiguousModulePath,
  ModulePathResolution,
  ResolvedModulePath,
  UnresolvedModulePath
} from './WorkspaceModuleFileIndex'

export const MODULE_PATH_RESOLVER_SIGNATURE = 'deterministic-module-resolver-v1'

const JAVASCRIPT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'
] as const
const JAVASCRIPT_EXTENSION_FALLBACKS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.ts', '.tsx']]
])

interface ModulePathResolverBaseOptions {
  readonly workspaceRoot: string
  readonly configFiles: readonly string[]
  readonly readConfig?: ConfigFileReader
}

export type ModulePathResolverOptions = ModulePathResolverBaseOptions & (
  | {
      readonly workspaceFiles: readonly string[]
      readonly fileIndex?: never
    }
  | {
      readonly workspaceFiles?: never
      readonly fileIndex: WorkspaceModuleFileIndex
    }
)

export type ConfigFileReader = (
  workspaceRoot: string,
  relativePath: string
) => Promise<unknown>

interface PathMapping {
  readonly pattern: string
  readonly targets: readonly string[]
}

interface LoadedProjectConfig {
  readonly directory: string
  readonly baseUrl: string
  readonly paths: readonly PathMapping[]
  readonly projectReferenceNames: ReadonlySet<string>
}

/** 只解析能唯一命中的文件路径；歧义不会按数组顺序挑第一个。 */
export class ModulePathResolver {
  readonly signature = MODULE_PATH_RESOLVER_SIGNATURE
  private readonly fileIndex: WorkspaceModuleFileIndex

  private constructor(
    private readonly configs: readonly LoadedProjectConfig[],
    fileIndex: WorkspaceModuleFileIndex
  ) {
    this.fileIndex = fileIndex
  }

  static async create(options: ModulePathResolverOptions): Promise<ModulePathResolver> {
    const readConfig = options.readConfig ?? readWorkspaceJsonc
    const configs: LoadedProjectConfig[] = []
    for (const configPath of [...options.configFiles].sort()) {
      const basename = path.posix.basename(configPath).toLowerCase()
      if (basename !== 'tsconfig.json' && basename !== 'jsconfig.json') continue
      try {
        const value = await readConfig(options.workspaceRoot, configPath)
        const config = parseProjectConfig(configPath, value)
        if (config) configs.push(config)
      } catch {
        // 损坏配置不阻断结构索引；相关 bare import 会保持 unresolved。
      }
    }
    configs.sort((left, right) =>
      right.directory.length - left.directory.length ||
      left.directory.localeCompare(right.directory, 'en')
    )
    const fileIndex = options.fileIndex ?? new WorkspaceModuleFileIndex(options.workspaceFiles)
    return new ModulePathResolver(Object.freeze(configs), fileIndex)
  }

  resolve(
    importerPath: string,
    moduleSpecifier: string
  ): ModulePathResolution {
    if (moduleSpecifier.startsWith('.')) {
      const base = path.posix.join(path.posix.dirname(importerPath), moduleSpecifier)
      return this.resolveCandidates(base, JAVASCRIPT_EXTENSIONS, 'relative-path')
    }
    if (moduleSpecifier.startsWith('#')) {
      return unresolved('unsupported_conditional_export', 'structural')
    }

    const config = this.configFor(importerPath)
    if (!config) return unresolved('external_module', 'structural')
    const mappedBases: string[] = []
    let matchedPathPattern = false
    for (const mapping of config.paths) {
      const wildcard = matchPathPattern(mapping.pattern, moduleSpecifier)
      if (wildcard === null) continue
      matchedPathPattern = true
      for (const target of mapping.targets) {
        const replaced = target.replace('*', wildcard)
        const candidate = workspaceJoin(config.baseUrl, replaced)
        if (candidate) mappedBases.push(candidate)
      }
    }
    if (matchedPathPattern) {
      return this.resolveBaseSet(mappedBases, JAVASCRIPT_EXTENSIONS, 'tsconfig-paths')
    }

    if (config.projectReferenceNames.has(moduleSpecifier)) {
      return unresolved('unsupported_project_reference', 'tsconfig-paths')
    }
    const baseUrlCandidate = workspaceJoin(config.baseUrl, moduleSpecifier)
    if (baseUrlCandidate) {
      const resolution = this.resolveCandidates(
        baseUrlCandidate,
        JAVASCRIPT_EXTENSIONS,
        'tsconfig-paths'
      )
      if (resolution.kind !== 'unresolved') return resolution
    }
    return unresolved('external_module', 'tsconfig-paths')
  }

  private configFor(importerPath: string): LoadedProjectConfig | null {
    const importerDirectory = path.posix.dirname(importerPath)
    return this.configs.find((config) =>
      config.directory === '' ||
      importerDirectory === config.directory ||
      importerDirectory.startsWith(`${config.directory}/`)
    ) ?? null
  }

  private resolveBaseSet(
    bases: readonly string[],
    extensions: readonly string[],
    resolver: CodeRelationResolver
  ): ModulePathResolution {
    const candidates = new Set<string>()
    for (const base of bases) {
      for (const candidate of this.fileIndex.candidates(base, {
        extensions,
        explicitExtensionFallbacks: JAVASCRIPT_EXTENSION_FALLBACKS
      })) {
        candidates.add(candidate)
      }
    }
    return resolutionFromCandidates([...candidates], resolver)
  }

  private resolveCandidates(
    base: string,
    extensions: readonly string[],
    resolver: CodeRelationResolver
  ): ModulePathResolution {
    return resolutionFromCandidates(
      this.fileIndex.candidates(base, {
        extensions,
        explicitExtensionFallbacks: JAVASCRIPT_EXTENSION_FALLBACKS
      }),
      resolver
    )
  }
}

function parseProjectConfig(
  configPath: string,
  value: unknown
): LoadedProjectConfig | null {
  if (!isRecord(value)) return null
  const compilerOptions = isRecord(value.compilerOptions) ? value.compilerOptions : {}
  const directory = path.posix.dirname(configPath) === '.'
    ? ''
    : path.posix.dirname(configPath)
  const configuredBaseUrl = typeof compilerOptions.baseUrl === 'string'
    ? compilerOptions.baseUrl
    : '.'
  const baseUrl = workspaceJoin(directory, configuredBaseUrl) ?? directory
  const paths: PathMapping[] = []
  if (isRecord(compilerOptions.paths)) {
    for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths)) {
      if (!Array.isArray(rawTargets)) continue
      const targets = rawTargets.filter((target): target is string => typeof target === 'string')
      if (targets.length > 0 && countOccurrences(pattern, '*') <= 1) {
        paths.push(Object.freeze({ pattern, targets: Object.freeze(targets) }))
      }
    }
  }
  paths.sort((left, right) => right.pattern.length - left.pattern.length ||
    left.pattern.localeCompare(right.pattern, 'en'))

  const projectReferenceNames = new Set<string>()
  if (Array.isArray(value.references)) {
    for (const reference of value.references) {
      if (!isRecord(reference) || typeof reference.path !== 'string') continue
      const normalized = reference.path.replace(/\\/g, '/').replace(/\/$/, '')
      const name = path.posix.basename(normalized)
      if (name) projectReferenceNames.add(name)
    }
  }
  return Object.freeze({
    directory,
    baseUrl,
    paths: Object.freeze(paths),
    projectReferenceNames
  })
}

async function readWorkspaceJsonc(
  workspaceRoot: string,
  relativePath: string
): Promise<unknown> {
  const normalized = normalizeWorkspacePath(relativePath)
  if (!normalized) throw new Error('配置路径不安全')
  const rootCanon = canonicalizeExistingPath(path.resolve(workspaceRoot))
  if (!rootCanon.ok) throw new Error(rootCanon.reason)
  const fileCanon = canonicalizeExistingPath(path.resolve(rootCanon.path, ...normalized.split('/')))
  if (!fileCanon.ok) throw new Error(fileCanon.reason)
  if (!isPathWithinRoot(rootCanon.path, fileCanon.path)) {
    throw new Error('配置路径越过 workspace')
  }
  const content = await readFile(fileCanon.path, 'utf8')
  const parsed: unknown = JSON.parse(stripTrailingCommas(stripJsonComments(content)))
  return parsed
}

function stripJsonComments(content: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        if (content[index] === '\n') result += '\n'
        index += 1
      }
      index += 1
      continue
    }
    result += char
  }
  return result
}

function stripTrailingCommas(content: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (/\s/.test(content[lookahead] ?? '')) lookahead += 1
      if (content[lookahead] === '}' || content[lookahead] === ']') continue
    }
    result += char
  }
  return result
}

function unresolved(
  reason: UnresolvedModulePath['reason'],
  resolver: CodeRelationResolver
): UnresolvedModulePath {
  return Object.freeze({ kind: 'unresolved', reason, resolver })
}

function matchPathPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star < 0) return pattern === specifier ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function workspaceJoin(base: string, candidate: string): string | null {
  return normalizeWorkspacePath(path.posix.join(base, candidate.replace(/\\/g, '/')))
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
