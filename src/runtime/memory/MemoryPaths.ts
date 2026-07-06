/**
 * 记忆文件路径约定：按工作区根目录哈希隔离各项目 scope。
 *
 * 目录布局：{userData}/memory/{workspaceHash}/MEMORY.md
 * workspaceHash = sha256(normalize(workspaceRoot)).slice(0, 16)
 */
import { createHash } from 'node:crypto'
import { join, normalize, resolve, sep } from 'path'

/** scope 目录名长度（sha256 十六进制前缀） */
export const WORKSPACE_HASH_LENGTH = 16

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
  const normalized = normalizeWorkspaceRoot(workspaceRoot)
  return createHash('sha256').update(normalized).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

/**
 * 记忆根目录：{userData}/memory
 * @param userDataPath Electron app.getPath('userData')
 */
export function getMemoryRoot(userDataPath: string): string {
  return join(userDataPath, 'memory')
}

/**
 * 单个项目 scope 目录：{memoryRoot}/{scopeId}
 * @param memoryRoot getMemoryRoot 返回值
 * @param scopeId computeWorkspaceHash 返回值
 */
export function getProjectMemoryDir(memoryRoot: string, scopeId: string): string {
  return join(memoryRoot, scopeId)
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
  const relative = absMd.slice(prefix.length)
  const parts = relative.split(/[/\\]/).filter(Boolean)
  if (parts.length !== 2 || parts[1] !== 'MEMORY.md') {
    return null
  }
  const scopeId = parts[0]
  return SCOPE_ID_RE.test(scopeId) ? scopeId : null
}

/**
 * 从 scope 目录名反解 scopeId；非 16 位十六进制时返回 null
 * @param dirName 目录 basename（非完整路径）
 */
export function parseScopeIdFromDirName(dirName: string): string | null {
  return SCOPE_ID_RE.test(dirName) ? dirName : null
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
