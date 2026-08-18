/**
 * source-bound 记忆懒校验：只校验本次将参与默认检索的少量记录，禁止全量扫描。
 * 指纹格式与文档索引约定一致：`${size}-${Math.floor(mtimeMs)}`（computeFingerprint）。
 * stat 抛错按类别分流：文件不存在（ENOENT）判失效；其余（权限/占用等）视为无法验证，
 * 不误杀记录；状态写回失败同样不阻塞检索，下次仍会重新校验。
 */
import { statSync } from 'fs'
import { resolve, sep } from 'path'
import { computeFingerprint } from '../FtsQueryBuilder'
import type { MemoryRepository } from '../repository/MemoryRepository'

export interface MemorySourceStat {
  size: number
  mtimeMs: number
}

export type MemorySourceStatFn = (absolutePath: string) => MemorySourceStat

export type MemoryVerifyOutcome = 'verified' | 'stale' | 'unverifiable'

export interface MemoryVerifierDeps {
  repository: Pick<MemoryRepository, 'updateStatus'>
  /** stat 源；测试注入 fake */
  stat?: MemorySourceStatFn
}

export class MemoryVerifier {
  private readonly statFn: MemorySourceStatFn

  constructor(private readonly deps: MemoryVerifierDeps) {
    this.statFn = deps.stat ?? defaultStat
  }

  /**
   * 校验单条记录的来源绑定。stale 表示来源缺失或指纹变化，记录已被标记
   * needs_verification；verified 表示来源未变；unverifiable 表示无法判定，保持原状。
   */
  verify(
    record: { id: string; source: { path: string; fingerprint: string } | null },
    workspaceRoot: string | null | undefined
  ): MemoryVerifyOutcome {
    if (!workspaceRoot || !record.source) {
      return 'unverifiable'
    }
    const absolutePath = resolveWithinWorkspace(workspaceRoot, record.source.path)
    if (absolutePath === null) {
      return 'unverifiable'
    }

    let stat: MemorySourceStat
    try {
      stat = this.statFn(absolutePath)
    } catch (err) {
      if (isFileNotFound(err)) {
        return this.markStale(record.id)
      }
      return 'unverifiable'
    }

    const fingerprint = computeFingerprint(stat.size, Math.floor(stat.mtimeMs))
    if (fingerprint !== record.source.fingerprint) {
      return this.markStale(record.id)
    }
    return 'verified'
  }

  private markStale(id: string): MemoryVerifyOutcome {
    try {
      this.deps.repository.updateStatus(id, 'needs_verification')
    } catch {
      // 状态写回失败不改变本次判定，下次检索会重新校验
    }
    return 'stale'
  }
}

function defaultStat(absolutePath: string): MemorySourceStat {
  const stat = statSync(absolutePath)
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

/** sourcePath 只允许是工作区内的相对路径；越界视为无法验证 */
function resolveWithinWorkspace(workspaceRoot: string, sourcePath: string): string | null {
  const normalized = sourcePath.replace(/\\/g, '/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    return null
  }
  const absRoot = resolve(workspaceRoot)
  const absTarget = resolve(absRoot, ...normalized.split('/'))
  const rootPrefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep
  if (
    absTarget.toLowerCase() !== absRoot.toLowerCase() &&
    !absTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())
  ) {
    return null
  }
  return absTarget
}
