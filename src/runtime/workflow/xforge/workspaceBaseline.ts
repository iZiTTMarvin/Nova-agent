import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { relative, resolve } from 'path'
import {
  canonicalizeRoot,
  resolveExistingPathUnderRoot
} from '../pathSafety'

import type {
  XForgeWorkspaceBaselineEntry,
  XForgeWorkspaceBaselineV1,
  XForgeReviewTarget
} from '../../../shared/xforge/types'

export type {
  XForgeWorkspaceBaselineEntry,
  XForgeWorkspaceBaselineV1,
  XForgeReviewTarget
}

const MAX_BASELINE_FILES = 2_000
const MAX_BASELINE_FILE_BYTES = 64 * 1024 * 1024
const MAX_BASELINE_TOTAL_BYTES = 128 * 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024

export function resolveXForgeReviewTarget(params: {
  reviewOnly: boolean
  codeReadyForTest?: boolean
}): XForgeReviewTarget {
  if (params.reviewOnly || params.codeReadyForTest === true) {
    return { kind: 'existing_worktree' }
  }
  return { kind: 'run_effects' }
}

export function cloneWorkspaceBaseline(
  baseline: XForgeWorkspaceBaselineV1
): XForgeWorkspaceBaselineV1 {
  return {
    schemaVersion: 1,
    capturedAt: baseline.capturedAt,
    headOid: baseline.headOid,
    entries: baseline.entries.map(entry => ({ ...entry }))
  }
}

export function cloneReviewTarget(target: XForgeReviewTarget): XForgeReviewTarget {
  return { kind: target.kind }
}

/** 在业务写入前冻结工作区身份；敏感路径和无法完整证明的工作区会直接拒绝。 */
export async function captureXForgeWorkspaceBaseline(
  workspaceRoot: string
): Promise<XForgeWorkspaceBaselineV1> {
  const root = await canonicalizeRoot(workspaceRoot)
  const gitWorkTree = await isGitWorkTree(root)
  const headOid = gitWorkTree ? await readGitHeadOid(root) : null
  const entries = gitWorkTree
    ? await listGitDirtyWorkspaceEntries(root, headOid)
    : await listFilesystemEntriesAsUntracked(root)
  const headAfterCapture = gitWorkTree ? await readGitHeadOid(root) : null
  if (headAfterCapture !== headOid) {
    throw new Error('Workspace Baseline 捕获期间 HEAD 已变化，请重试')
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    headOid,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path))
  }
}

export async function listDirtyWorkspaceEntries(
  workspaceRoot: string
): Promise<XForgeWorkspaceBaselineEntry[]> {
  const root = await canonicalizeRoot(workspaceRoot)
  if (!(await isGitWorkTree(root))) {
    return listFilesystemEntriesAsUntracked(root)
  }

  const headOid = await readGitHeadOid(root)
  return listGitDirtyWorkspaceEntries(root, headOid)
}

async function listGitDirtyWorkspaceEntries(
  root: string,
  headOid: string | null
): Promise<XForgeWorkspaceBaselineEntry[]> {
  const trackedNames = splitNull(
    await runGitText(
      root,
      headOid
        ? ['diff', '--name-only', '-z', headOid, '--']
        : ['ls-files', '-z', '--']
    )
  )
  const untrackedNames = splitNull(
    await runGitText(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
  )
  return buildEntries(root, [
    ...trackedNames.map(path => ({ path, kind: 'tracked' as const })),
    ...untrackedNames.map(path => ({ path, kind: 'untracked' as const }))
  ])
}

export async function hashWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  maxBytes = MAX_BASELINE_FILE_BYTES
): Promise<string | null> {
  const root = await canonicalizeRoot(workspaceRoot)
  const identity = await hashWorkspaceFileIdentity(root, normalizePath(relativePath), maxBytes)
  return identity?.contentHash ?? null
}

export async function readHeadOid(workspaceRoot: string): Promise<string | null> {
  const root = await canonicalizeRoot(workspaceRoot)
  if (!(await isGitWorkTree(root))) return null
  return readGitHeadOid(root)
}

async function readGitHeadOid(workspaceRoot: string): Promise<string | null> {
  try {
    const oid = (await runGitText(workspaceRoot, ['rev-parse', '--verify', 'HEAD'])).trim()
    return oid.length > 0 ? oid : null
  } catch (headError) {
    try {
      await runGitText(workspaceRoot, ['symbolic-ref', '-q', 'HEAD'])
      return null
    } catch {
      throw headError
    }
  }
}

export async function readTrackedFileAtHead(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number,
  headOid = 'HEAD'
): Promise<{ content: string; binary: boolean } | null> {
  const normalized = normalizePath(relativePath)
  if (!/^[0-9a-f]{40,64}$/i.test(headOid) && headOid !== 'HEAD') {
    throw new Error(`非法 Git revision: ${headOid}`)
  }
  const objectRef = `${headOid}:${normalized}`
  let sizeText: string
  try {
    sizeText = await runGitText(workspaceRoot, ['cat-file', '-s', objectRef])
  } catch {
    return null
  }
  const size = Number(sizeText.trim())
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`无法确认 HEAD 文件大小: ${normalized}`)
  }
  if (size > maxBytes) {
    throw new Error(`Review Snapshot 文件 ${normalized} 超过 ${maxBytes} 字节上限`)
  }
  const buffer = await runGitBuffer(workspaceRoot, ['show', objectRef], maxBytes + 1)
  const binary = buffer.includes(0)
  return {
    content: binary ? '' : buffer.toString('utf8'),
    binary
  }
}

export function isRuntimeGeneratedPath(file: string): boolean {
  const normalized = normalizePath(file)
  return (
    normalized.startsWith('.nova/compose/') ||
    normalized.startsWith('node_modules/') ||
    normalized.startsWith('out/') ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('release/')
  )
}

export function isSensitiveReviewPath(file: string): boolean {
  const name = (file.split('/').pop() ?? '').toLowerCase()
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx)$/i.test(name) ||
    /(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/i.test(name)
  )
}

async function buildEntries(
  root: string,
  candidates: Array<{ path: string; kind: XForgeWorkspaceBaselineEntry['kind'] }>
): Promise<XForgeWorkspaceBaselineEntry[]> {
  const entries: XForgeWorkspaceBaselineEntry[] = []
  const seen = new Set<string>()
  let totalBytes = 0

  for (const candidate of candidates) {
    const path = normalizePath(candidate.path)
    if (!path || seen.has(path) || isRuntimeGeneratedPath(path)) continue
    if (isSensitiveReviewPath(path)) {
      throw new Error(`Workspace Baseline 包含敏感文件，拒绝读取: ${path}`)
    }
    seen.add(path)
    if (seen.size > MAX_BASELINE_FILES) {
      throw new Error(`Workspace Baseline 文件数超过安全上限 ${MAX_BASELINE_FILES}`)
    }
    const identity = await hashWorkspaceFileIdentity(root, path, MAX_BASELINE_FILE_BYTES)
    totalBytes += identity?.size ?? 0
    if (totalBytes > MAX_BASELINE_TOTAL_BYTES) {
      throw new Error(`Workspace Baseline 文件总量超过 ${MAX_BASELINE_TOTAL_BYTES} 字节上限`)
    }
    entries.push({
      path,
      kind: candidate.kind,
      contentHash: identity?.contentHash ?? null
    })
  }
  return entries
}

async function hashWorkspaceFileIdentity(
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<{ contentHash: string; size: number } | null> {
  const resolved = await resolveExistingPathUnderRoot(root, relativePath)
  if (!resolved) return null
  if (!resolved.stats.isFile()) return null
  if (resolved.stats.size > maxBytes) {
    throw new Error(`文件 ${relativePath} 超过 ${maxBytes} 字节安全上限`)
  }

  const hash = createHash('sha256')
  let bytesRead = 0
  for await (const chunk of createReadStream(resolved.absolutePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytesRead += buffer.length
    if (bytesRead > maxBytes) {
      throw new Error(`文件 ${relativePath} 在读取期间超过 ${maxBytes} 字节安全上限`)
    }
    hash.update(buffer)
  }
  return { contentHash: hash.digest('hex'), size: bytesRead }
}

async function isGitWorkTree(workspaceRoot: string): Promise<boolean> {
  try {
    return (await runGitText(workspaceRoot, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch (error) {
    if (hasProcessExitCode(error, 128)) return false
    throw error
  }
}

async function listFilesystemEntriesAsUntracked(
  root: string
): Promise<XForgeWorkspaceBaselineEntry[]> {
  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'release'])
  const candidates: Array<{ path: string; kind: 'untracked' }> = []

  const visit = async (dir: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true })
    for (const child of children) {
      if (ignored.has(child.name)) continue
      const abs = resolve(dir, child.name)
      const rel = normalizePath(relative(root, abs))
      if (!rel || isRuntimeGeneratedPath(rel)) continue
      if (child.isDirectory()) {
        await visit(abs)
      } else if (child.isFile()) {
        candidates.push({ path: rel, kind: 'untracked' })
        if (candidates.length > MAX_BASELINE_FILES) {
          throw new Error(`Workspace Baseline 文件数超过安全上限 ${MAX_BASELINE_FILES}`)
        }
      }
    }
  }

  await visit(root)
  return buildEntries(root, candidates)
}

function runGitText(root: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES
    }, (error, stdout) => {
      if (error) reject(error)
      else resolvePromise(stdout)
    })
  })
}

function runGitBuffer(root: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, {
      cwd: root,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer
    }, (error, stdout) => {
      if (error) reject(error)
      else resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '')
}

function splitNull(value: string): string[] {
  return value.split('\0').filter(item => item.length > 0)
}

function hasProcessExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
