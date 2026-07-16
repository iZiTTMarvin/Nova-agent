import { createHash } from 'crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import type { XForgeEvidenceRef, XForgeStageArtifactRef, XForgeWorkspaceFingerprint } from './runState'
import type { XForgeStage } from './types'

const DEFAULT_FINGERPRINT_LIMIT = 2000
const DEFAULT_FINGERPRINT_BYTES = 256 * 1024 * 1024
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId.includes('..')) {
    throw new Error(`非法 XForge runId: ${runId}`)
  }
}

export function getXForgeRunRoot(workspaceRoot: string, runId: string): string {
  assertSafeRunId(runId)
  return join(workspaceRoot, '.nova', 'compose', 'runs', runId)
}

export function getXForgeStageDir(
  workspaceRoot: string,
  runId: string,
  kind: 'idea' | 'plans' | 'evidence' | 'report'
): string {
  return join(getXForgeRunRoot(workspaceRoot, runId), kind)
}

function safeName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'artifact'
}

export function writeXForgeArtifact(params: {
  workspaceRoot: string
  runId: string
  stage: XForgeStage
  kind: 'idea' | 'plans' | 'evidence' | 'report'
  name: string
  content: string
}): XForgeStageArtifactRef {
  const dir = getXForgeStageDir(params.workspaceRoot, params.runId, params.kind)
  mkdirSync(dir, { recursive: true })
  const artifactId = `${params.stage}-${safeName(params.name)}`
  const absPath = join(dir, `${artifactId}.md`)
  atomicWriteFileSync(absPath, params.content)
  return {
    stage: params.stage,
    artifactId,
    path: relative(params.workspaceRoot, absPath).replace(/\\/g, '/'),
    summary: params.content.split(/\r?\n/).find(Boolean)?.slice(0, 160)
  }
}

export function writeXForgeEvidence(params: {
  workspaceRoot: string
  runId: string
  kind: string
  name: string
  content: string
  unverified?: boolean
}): XForgeEvidenceRef {
  const dir = getXForgeStageDir(params.workspaceRoot, params.runId, 'evidence')
  mkdirSync(dir, { recursive: true })
  const absPath = join(dir, `${safeName(params.name)}.md`)
  atomicWriteFileSync(absPath, params.content)
  return {
    kind: params.kind,
    path: relative(params.workspaceRoot, absPath).replace(/\\/g, '/'),
    ...(params.unverified ? { unverified: true } : {})
  }
}

export function createWorkspaceFingerprint(
  workspaceRoot: string,
  opts: { revision?: number; maxFiles?: number; maxTotalBytes?: number } = {}
): XForgeWorkspaceFingerprint {
  const root = resolve(workspaceRoot)
  const files = listFingerprintFiles(root, opts.maxFiles ?? DEFAULT_FINGERPRINT_LIMIT)
  const hash = createHash('sha256')
  let totalBytes = 0
  for (const file of files) {
    const abs = join(root, file)
    const stats = statSync(abs)
    hash.update(file)
    hash.update(String(stats.size))
    totalBytes += stats.size
    if (totalBytes > (opts.maxTotalBytes ?? DEFAULT_FINGERPRINT_BYTES)) {
      throw new Error('Workspace Fingerprint 超过内容哈希安全上限，拒绝生成不完整摘要')
    }
    hashFileInto(hash, abs)
  }
  return {
    revision: opts.revision ?? Date.now(),
    digest: hash.digest('hex'),
    capturedAt: Date.now()
  }
}

function hashFileInto(hash: ReturnType<typeof createHash>, absPath: string): void {
  const fd = openSync(absPath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(fd)
  }
}

function listFingerprintFiles(root: string, maxFiles: number): string[] {
  const out: string[] = []
  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'release'])

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (rel.startsWith('.nova/compose/')) continue
      if (entry.isDirectory()) {
        visit(abs)
      } else if (entry.isFile()) {
        out.push(rel)
        if (out.length > maxFiles) {
          throw new Error(`Workspace Fingerprint 文件数超过安全上限 ${maxFiles}，拒绝生成不完整摘要`)
        }
      }
    }
  }

  if (existsSync(root)) visit(root)
  return out.sort()
}

export function readArtifactText(workspaceRoot: string, ref: XForgeStageArtifactRef): string | null {
  if (!ref.path) return null
  const root = resolve(workspaceRoot)
  const abs = resolve(root, ref.path)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

export function ensureArtifactParent(absPath: string): void {
  mkdirSync(dirname(absPath), { recursive: true })
}
