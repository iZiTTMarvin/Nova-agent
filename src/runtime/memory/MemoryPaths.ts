/** 记忆目录按项目名称与规范化路径哈希隔离；全局目录固定为 global。 */
import { createHash } from 'node:crypto'
import { basename, join, normalize, resolve, sep, relative, parse } from 'path'
import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { MEMORY_TOPIC_FILES } from './markdown/entryFormat'

/** scope 目录名长度（sha256 十六进制前缀） */
export const WORKSPACE_HASH_LENGTH = 16

/** 全局用户 scope 的固定内部 ID。 */
export const GLOBAL_SCOPE_ID = 'user'

const SCOPE_ID_RE = /^[0-9a-f]{16}$/

/**
 * 规范化工作区根路径（与哈希输入一致）
 * @param workspaceRoot 工作区绝对或相对路径
 */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return normalize(resolve(workspaceRoot))
}

/**
 * 由工作区根目录计算 scopeId（workspaceHash）
 * @param workspaceRoot 工作区根路径
 */
export function computeWorkspaceHash(workspaceRoot: string): string {
  let normalized = normalizeWorkspaceRoot(workspaceRoot)
  const root = parse(normalized).root
  while (normalized.length > root.length && /[/\\]$/.test(normalized)) normalized = normalized.slice(0, -1)
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

export function computeLegacyWorkspaceHashes(workspaceRoot: string): string[] {
  const normalized = normalizeWorkspaceRoot(workspaceRoot)
  const variants = [normalized, normalized.replace(/^[a-zA-Z]:/, value => value.toUpperCase()), normalized.replace(/^[a-zA-Z]:/, value => value.toLowerCase())]
  return [...new Set(variants.map(value => createHash('sha256').update(value).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)))]
}

export function memoryProjectSlug(workspaceRoot: string): string {
  return basename(normalizeWorkspaceRoot(workspaceRoot)).toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'project'
}

export function getGlobalMemoryDir(memoryRoot: string): string {
  return join(memoryRoot, 'global')
}

export function isManagedMemoryFile(relPath: string, scopeKind: 'project' | 'global'): boolean {
  if (/[/\\]/.test(relPath)) return false
  if (['MEMORY.md', 'inbox.md', 'archive.md'].includes(relPath)) return true
  return Object.entries(MEMORY_TOPIC_FILES).some(([kind, name]) => name === relPath &&
    (scopeKind === 'project' || kind !== 'project_fact'))
}

export function isReservedMemoryFile(relPath: string): boolean {
  return !/[/\\]/.test(relPath) && (['MEMORY.md', 'inbox.md', 'archive.md', 'notes.md'].includes(relPath) || Object.values(MEMORY_TOPIC_FILES).includes(relPath))
}

export function listProjectMemoryDirs(memoryRoot: string, scopeId: string): string[] {
  if (!SCOPE_ID_RE.test(scopeId)) throw new Error('Invalid project scope ID')
  const projects = join(memoryRoot, 'projects')
  if (!existsSync(projects)) return []
  return readdirSync(projects, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith(`-${scopeId}`) && parseScopeIdFromDirName(entry.name) === scopeId)
    .map(entry => join(projects, entry.name)).sort()
}

/**
 * 记忆根目录：{userData}/memory
 * @param userDataPath Electron app.getPath('userData')
 */
export function getMemoryRoot(userDataPath: string): string {
  return join(userDataPath, 'memory')
}

/**
 * 单个项目 scope 目录：{memoryRoot}/projects/{slug}-{scopeId}
 * @param memoryRoot getMemoryRoot 返回值
 * @param scopeId computeWorkspaceHash 返回值
 */
export function getProjectMemoryDir(memoryRoot: string, scopeId: string, workspaceRoot?: string): string {
  if (scopeId === GLOBAL_SCOPE_ID) return getGlobalMemoryDir(memoryRoot)
  const candidates = listProjectMemoryDirs(memoryRoot, scopeId)
  const slug = workspaceRoot ? memoryProjectSlug(workspaceRoot) : 'project'
  const preferred = join(memoryRoot, 'projects', `${slug}-${scopeId}`)
  return candidates.find(candidate => candidate === preferred) ?? candidates[0] ?? preferred
}

export class MemoryScopeDirectoryResolver {
  private readonly paths = new Map<string, string>()
  private readonly workspaces = new Map<string, string>()

  constructor(private readonly memoryRoot: string) {}

  registerWorkspace(workspaceRoot: string): string {
    const scopeId = computeWorkspaceHash(workspaceRoot)
    this.workspaces.set(scopeId, workspaceRoot)
    this.paths.delete(scopeId)
    return scopeId
  }

  resolve(scopeId: string): string {
    const cached = this.paths.get(scopeId)
    // lstat 不跟随链接：符号链接或 junction 不会被识别为目录，需要重新解析。
    if (cached && lstatSync(cached, { throwIfNoEntry: false })?.isDirectory()) return cached
    const path = getProjectMemoryDir(this.memoryRoot, scopeId, this.workspaces.get(scopeId))
    if (existsSync(path)) this.paths.set(scopeId, path)
    return path
  }

  clear(): void {
    this.paths.clear()
    this.workspaces.clear()
  }

  getWorkspaceRoot(scopeId: string): string | undefined { return this.workspaces.get(scopeId) }
}

/**
 * 项目精华文件 MEMORY.md 的绝对路径
 * @param memoryRoot getMemoryRoot 返回值
 * @param scopeId computeWorkspaceHash 返回值
 */
export function getMemoryMdPath(memoryRoot: string, scopeId: string): string {
  return join(getProjectMemoryDir(memoryRoot, scopeId), 'MEMORY.md')
}

/**
 * 全局记忆索引库路径：{memoryRoot}/memory.db
 * @param memoryRoot getMemoryRoot 返回值
 */
export function getMemoryDbPath(memoryRoot: string): string {
  return join(memoryRoot, 'memory.db')
}

/**
 * 从 MEMORY.md 绝对路径反解 scopeId；路径不在 memoryRoot 下或格式不符时返回 null
 * @param memoryMdPath MEMORY.md 绝对路径
 * @param memoryRoot getMemoryRoot 返回值
 */
export function parseScopeIdFromMemoryMdPath(memoryMdPath: string, memoryRoot: string): string | null {
  const absMd = normalize(resolve(memoryMdPath))
  const absRoot = normalize(resolve(memoryRoot))
  const prefix = absRoot.endsWith('/') || absRoot.endsWith('\\') ? absRoot : absRoot + (process.platform === 'win32' ? '\\' : '/')
  if (!absMd.toLowerCase().startsWith(prefix.toLowerCase())) {
    return null
  }
  const parts = relative(absRoot, absMd).split(/[/\\]/)
  if (parts.length === 2 && parts[0] === 'global' && parts[1] === 'MEMORY.md') return GLOBAL_SCOPE_ID
  if (parts.length !== 3 || parts[0] !== 'projects' || parts[2] !== 'MEMORY.md') return null
  return parseScopeIdFromDirName(parts[1])
}

/**
 * 从项目目录名反解 scopeId。
 * @param dirName 目录 basename（非完整路径）
 */
export function parseScopeIdFromDirName(dirName: string): string | null {
  return /^[a-z0-9._-]+-([0-9a-f]{16})$/.exec(dirName)?.[1] ?? null
}

/**
 * 将 relPath 解析为 scope 目录内的绝对路径；归一化后仍越界则拒绝（防 ../ 穿越）。
 * @throws 路径非法或超出 scope 目录
 */
export function resolveSafeScopeRelPath(scopeDir: string, relPath: string): string {
  if (!relPath?.trim()) {
    throw new Error('relPath 不能为空')
  }

  const normalizedRel = relPath.replace(/\\/g, '/')
  if (normalizedRel.includes(':') || normalizedRel.includes('\0')) throw new Error('非法路径：禁止流名称或空字符')
  if (normalizedRel.startsWith('/') || /^[a-zA-Z]:/.test(normalizedRel)) {
    throw new Error('relPath 必须是相对路径')
  }
  if (normalizedRel.split('/').some((seg) => seg === '..')) {
    throw new Error('非法路径：禁止路径穿越')
  }
  if (!normalizedRel.toLowerCase().endsWith('.md')) {
    throw new Error('仅允许读写 .md 文件')
  }

  const absScope = resolve(scopeDir)
  const absTarget = resolve(absScope, ...normalizedRel.split('/'))
  const scopePrefix = absScope.endsWith(sep) ? absScope : absScope + sep

  if (
    absTarget.toLowerCase() !== absScope.toLowerCase() &&
    !absTarget.toLowerCase().startsWith(scopePrefix.toLowerCase())
  ) {
    throw new Error('非法路径：超出 scope 目录')
  }

  return absTarget
}
