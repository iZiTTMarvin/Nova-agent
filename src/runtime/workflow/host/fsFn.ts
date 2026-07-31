/**
 * 文件能力：read / write / delete / exists / glob。
 *
 * 两条硬边界：
 * 1. 路径安全 —— 只接受工作区内的相对路径，绝对路径、`..`、越界 symlink 一律抛错；
 * 2. scope 关闭后拒绝写 —— 取消/超时后旧 continuation 不得再改用户文件。
 *
 * 写入与删除都落 FileEffectReceipt（prepared → committed），
 * 使 resume 能跳过内容已一致的写入，并为回滚保留改前备份。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import {
  buildFileEffectReceipt,
  commitFileEffect,
  hashFileIfExists,
  nextFileEffectSequence,
  readFileEffect,
  recordFileEffect,
  resolveUnderWorkspace
} from '../effects/fileEffect'
import { effectIdFromKey } from '../effects/sideEffectCtx'
import { runDir } from '../state/paths'
import { assertScopeLive, type HostContext } from './types'

export interface FsFns {
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string) => Promise<void>
  delete: (path: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  glob: (pattern: string) => Promise<string[]>
}

/** 目录遍历跳过的大目录：避免 glob 在 node_modules 上退化 */
const SKIP_DIRS = new Set(['node_modules', '.git'])

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 相对工作区的规范化路径，用于稳定 effectId */
function relKey(workspaceRoot: string, absPath: string): string {
  return relative(workspaceRoot, absPath).replace(/\\/g, '/')
}

function backupDirOf(ctx: HostContext): string {
  return join(runDir(ctx.workspaceRoot, ctx.runId), 'effect-backups')
}

/** 把改前内容存进 run 目录，receipt 只记相对引用（禁止信任绝对路径） */
function backupBefore(ctx: HostContext, effectId: string, content: Buffer): string {
  const dir = backupDirOf(ctx)
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(join(dir, `${effectId}.bak`), content)
  return `effect-backups/${effectId}.bak`
}

export function createFsFns(ctx: HostContext): FsFns {
  const workspaceRoot = ctx.workspaceRoot

  const read = async (path: string): Promise<string | null> => {
    const abs = resolveUnderWorkspace(workspaceRoot, String(path ?? ''))
    if (!existsSync(abs)) return null
    return readFileSync(abs, 'utf-8')
  }

  const write = async (path: string, content: string): Promise<void> => {
    if (!assertScopeLive(ctx)) {
      throw new Error('TaskScope closed: cannot write')
    }
    const abs = resolveUnderWorkspace(workspaceRoot, String(path ?? ''))
    const text = String(content ?? '')
    const afterHash = sha256(text)
    const effectId = effectIdFromKey(`${relKey(workspaceRoot, abs)}:write`)

    // resume：已 committed 且磁盘内容已是目标内容 → 不重复写
    const existing = readFileEffect(workspaceRoot, ctx.runId, effectId)
    if (existing?.status === 'committed' && existing.afterHash === afterHash) {
      if (hashFileIfExists(abs) === afterHash) return
    }
    // prepared 后崩溃且磁盘已是目标内容 → 只补 commit
    if (existing?.status === 'prepared' && existing.afterHash === afterHash) {
      if (hashFileIfExists(abs) === afterHash) {
        commitFileEffect(workspaceRoot, ctx.runId, effectId, { afterHash })
        return
      }
    }

    const isNew = !existsSync(abs)
    const beforeBuf = isNew ? null : readFileSync(abs)
    const beforeHash = beforeBuf ? sha256(beforeBuf) : null
    const beforeCheckpointRef = beforeBuf ? backupBefore(ctx, effectId, beforeBuf) : null

    recordFileEffect(
      workspaceRoot,
      buildFileEffectReceipt({
        workspaceRoot,
        runId: ctx.runId,
        absPath: abs,
        action: isNew ? 'create' : 'modify',
        beforeHash,
        beforeCheckpointRef,
        afterHash,
        effectId,
        status: 'prepared',
        sequence: nextFileEffectSequence(workspaceRoot, ctx.runId)
      })
    )

    mkdirSync(dirname(abs), { recursive: true })
    if (ctx.checkpointManager) {
      if (!ctx.checkpointManager.getCurrentMessageId()) {
        ctx.checkpointManager.beginMessage(`workflow-${ctx.runId}`)
      }
      ctx.checkpointManager.backupBeforeWrite(abs, isNew)
    }
    // 备份与 receipt 期间可能已被取消：真正落盘前再校验一次
    if (!assertScopeLive(ctx)) {
      throw new Error('TaskScope closed: cannot write')
    }
    writeFileSync(abs, text, 'utf-8')

    const actualAfter = sha256(readFileSync(abs))
    if (actualAfter !== afterHash) {
      throw new Error(`写后 hash 不一致: expected=${afterHash} actual=${actualAfter}`)
    }
    commitFileEffect(workspaceRoot, ctx.runId, effectId, { afterHash: actualAfter })
  }

  const deleteFn = async (path: string): Promise<void> => {
    if (!assertScopeLive(ctx)) {
      throw new Error('TaskScope closed: cannot delete')
    }
    const abs = resolveUnderWorkspace(workspaceRoot, String(path ?? ''))
    const effectId = effectIdFromKey(`${relKey(workspaceRoot, abs)}:delete`)

    if (!existsSync(abs)) {
      // 目标已不存在：记一条 committed delete，保证 resume 对账时不判为"漏删"
      recordFileEffect(
        workspaceRoot,
        buildFileEffectReceipt({
          workspaceRoot,
          runId: ctx.runId,
          absPath: abs,
          action: 'delete',
          beforeHash: null,
          beforeCheckpointRef: null,
          afterHash: null,
          effectId,
          status: 'committed',
          sequence: nextFileEffectSequence(workspaceRoot, ctx.runId)
        })
      )
      return
    }

    const beforeBuf = readFileSync(abs)
    const prepared = buildFileEffectReceipt({
      workspaceRoot,
      runId: ctx.runId,
      absPath: abs,
      action: 'delete',
      beforeHash: sha256(beforeBuf),
      beforeCheckpointRef: backupBefore(ctx, effectId, beforeBuf),
      afterHash: null,
      effectId,
      status: 'prepared',
      sequence: nextFileEffectSequence(workspaceRoot, ctx.runId)
    })
    recordFileEffect(workspaceRoot, prepared)

    if (!assertScopeLive(ctx)) {
      throw new Error('TaskScope closed: cannot delete')
    }
    unlinkSync(abs)
    if (hashFileIfExists(abs) !== null) {
      throw new Error(`删除后文件仍存在: ${abs}`)
    }
    // delete 的 afterHash 恒为 null，无法走 commitFileEffect（它要求 afterHash）
    recordFileEffect(workspaceRoot, { ...prepared, status: 'committed', at: Date.now() })
  }

  const exists = async (path: string): Promise<boolean> => {
    const abs = resolveUnderWorkspace(workspaceRoot, String(path ?? ''))
    return existsSync(abs)
  }

  const glob = async (pattern: string): Promise<string[]> => {
    const pat = String(pattern ?? '').replace(/\\/g, '/')
    if (!pat || pat.startsWith('/') || pat.includes('..') || /^[A-Za-z]:/.test(pat)) {
      throw new Error(`glob pattern escapes workspace: ${pat}`)
    }
    return walkGlob(workspaceRoot, pat)
  }

  return { read, write, delete: deleteFn, exists, glob }
}

/** 把 glob 通配符编译为整串匹配的正则：** 跨目录、* 单段、? 单字符 */
export function compileGlob(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.*/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (pattern[i] === '*') {
      regex += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(pattern[i]!)) {
      regex += '\\' + pattern[i]
      i++
    } else {
      regex += pattern[i]
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}

async function walkGlob(root: string, pattern: string): Promise<string[]> {
  const re = compileGlob(pattern)
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (ent.isDirectory()) {
        if (rel && re.test(rel)) out.push(rel)
        if (SKIP_DIRS.has(ent.name)) continue
        await walk(abs)
      } else if (ent.isFile()) {
        if (re.test(rel)) out.push(rel)
      }
    }
  }

  await walk(root)
  return out.sort()
}
