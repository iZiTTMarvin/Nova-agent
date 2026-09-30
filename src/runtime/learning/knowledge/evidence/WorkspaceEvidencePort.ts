/**
 * 工作区只读取证：枚举可读文件、统计引用、按策略排序并切出候选片段。
 * 只产出按优先级排好的候选；装入多少由构建方按 token 预算决定。
 */
import { createHash, randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  LEARNING_DISCOVERY_MAX_ENTRIES,
  LEARNING_EVIDENCE_PER_FILE_MAX_BYTES,
  LEARNING_IMPORT_SCAN_BYTES,
  LEARNING_SKELETON_MAX_CANDIDATE_FRAGMENTS
} from '../../../../shared/learning/buildLimits'
import {
  canonicalizeExistingPath,
  createCanonicalPathCache,
  isPathWithinRoot,
  toWorkspaceRelativePath
} from '../../../permissions/pathAccess'
import { isPathSkipped, loadIgnoreMatcher } from '../../../workspace'
import type { EvidenceFragment, EvidencePackage } from './evidenceTypes'
import { LEARNING_EVIDENCE_STRATEGY_VERSION } from './evidenceTypes'
import {
  buildProjectLayout,
  evidenceFileKind,
  extractRelativeImports,
  isCodePath,
  isExcludedEvidencePath,
  packageEntryPaths,
  rankEvidenceCandidates,
  resolveRelativeImport,
  selectFragmentWindow,
  sliceLines
} from './evidenceStrategy'
import { isSensitiveRelativePath } from './sensitivePaths'
import { deriveProjectId, normalizeWorkspaceForProject } from '../../storage/workerCommand'

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.yaml', '.yml'
])

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 只读取上限内的前缀；二进制文件返回 null。 */
async function readCappedText(absPath: string, maxBytes: number): Promise<{ text: string } | null> {
  const handle = await open(absPath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const toRead = Math.min(stat.size, maxBytes)
    const buf = Buffer.alloc(toRead)
    if (toRead > 0) await handle.read(buf, 0, toRead, 0)
    if (isBinaryBuffer(buf)) return null
    let text = buf.toString('utf8')
    if (stat.size > maxBytes) text = text.replace(/\uFFFD$/, '')
    return { text }
  } finally {
    await handle.close()
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

async function listReadableFiles(workspaceRoot: string, signal?: AbortSignal): Promise<string[]> {
  const ignore = await loadIgnoreMatcher(workspaceRoot)
  const cache = createCanonicalPathCache()
  const rootCanon = canonicalizeExistingPath(resolve(workspaceRoot), cache)
  if (!rootCanon.ok) return []

  const found: string[] = []
  let visited = 0

  async function walk(absDir: string): Promise<void> {
    signal?.throwIfAborted()
    if (visited >= LEARNING_DISCOVERY_MAX_ENTRIES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (++visited > LEARNING_DISCOVERY_MAX_ENTRIES) return
      const name = entry.name
      if (isPathSkipped(name)) continue
      const absPath = join(absDir, name)
      const rel = toWorkspaceRelativePath(workspaceRoot, absPath, cache)
      if (!rel || rel === '.') continue
      if (entry.isDirectory()) {
        if (ignore(rel, true)) continue
        await walk(absPath)
        continue
      }
      if (!entry.isFile()) continue
      if (ignore(rel, false)) continue
      if (isSensitiveRelativePath(rel)) continue
      const ext = name.includes('.') ? `.${name.split('.').pop()!.toLowerCase()}` : ''
      if (!TEXT_EXTENSIONS.has(ext)) continue
      found.push(rel.replace(/\\/g, '/'))
    }
  }

  await walk(rootCanon.path)
  return found
}

export class WorkspaceEvidencePort {
  async collectSkeletonEvidence(params: {
    workspaceRoot: string
    focusRelativePaths?: readonly string[]
    signal?: AbortSignal
  }): Promise<EvidencePackage> {
    const normalizedRoot = normalizeWorkspaceForProject(params.workspaceRoot)
    const projectId = deriveProjectId(normalizedRoot)
    const cache = createCanonicalPathCache()
    const rootCanon = canonicalizeExistingPath(resolve(normalizedRoot), cache)
    if (!rootCanon.ok) {
      throw new Error('工作区路径无效')
    }
    const readWithin = async (relPath: string, maxBytes: number): Promise<string | null> => {
      const absPath = join(rootCanon.path, relPath.split('/').join(sep))
      const target = canonicalizeExistingPath(absPath, cache)
      if (!target.ok || !isPathWithinRoot(rootCanon.path, target.path)) return null
      try {
        return (await readCappedText(target.path, maxBytes))?.text ?? null
      } catch {
        return null
      }
    }

    const files = await listReadableFiles(normalizedRoot, params.signal)
    const known = new Set(files)

    // 引用次数：只扫描代码文件开头，统计「被项目内其他文件引用」的次数
    const referenceCounts = new Map<string, number>()
    for (const path of files) {
      params.signal?.throwIfAborted()
      if (!isCodePath(path) || isExcludedEvidencePath(path)) continue
      const head = await readWithin(path, LEARNING_IMPORT_SCAN_BYTES)
      if (!head) continue
      for (const specifier of new Set(extractRelativeImports(head))) {
        const target = resolveRelativeImport(path, specifier, known)
        if (target && target !== path) referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1)
      }
    }
    const packageJson = known.has('package.json') ? await readWithin('package.json', LEARNING_EVIDENCE_PER_FILE_MAX_BYTES) : null
    const entryPaths = new Set(packageJson ? packageEntryPaths(packageJson, known) : [])

    const ranked = rankEvidenceCandidates({ paths: files, entryPaths, referenceCounts })
    const focus = new Set((params.focusRelativePaths ?? []).map(p => p.replace(/\\/g, '/')).filter(p => known.has(p)))

    const fragments: EvidenceFragment[] = []
    const collectedAt = Date.now()
    const taken = new Set<string>()
    /** 读取并切片；没有可用正文时返回 false，调用方继续尝试同组下一个。 */
    const tryTake = async (relPath: string): Promise<boolean> => {
      params.signal?.throwIfAborted()
      if (taken.has(relPath)) return false
      taken.add(relPath)
      const content = await readWithin(relPath, LEARNING_EVIDENCE_PER_FILE_MAX_BYTES)
      if (!content?.trim()) return false
      const window = selectFragmentWindow(evidenceFileKind(relPath), content)
      if (!window?.text.trim()) return false
      fragments.push({
        sourceId: randomUUID(),
        relativePath: relPath,
        startLine: window.startLine,
        endLine: window.endLine,
        snippetText: window.text,
        contentHash: hashText(content),
        snippetHash: hashText(window.text),
        symbolLabel: window.symbolLabel,
        collectedAt
      })
      return true
    }
    const full = () => fragments.length >= LEARNING_SKELETON_MAX_CANDIDATE_FRAGMENTS

    for (const path of [...focus, ...ranked.head]) {
      if (full()) break
      await tryTake(path)
    }
    // 每轮每个目录取一个可用片段；桶文件等无正文的文件不占该目录这一轮的名额
    const queues = ranked.groups.map(group => [...group])
    while (!full() && queues.some(queue => queue.length > 0)) {
      for (const queue of queues) {
        if (full()) break
        while (queue.length > 0 && !(await tryTake(queue.shift()!))) { /* 同组继续找 */ }
      }
    }
    for (const path of ranked.tail) {
      if (full()) break
      await tryTake(path)
    }

    return {
      projectId,
      workspaceRoot: normalizedRoot,
      strategyVersion: LEARNING_EVIDENCE_STRATEGY_VERSION,
      fragments,
      projectLayout: buildProjectLayout(files),
      fingerprint: fingerprintOf(fragments)
    }
  }
}

export function fingerprintOf(fragments: readonly EvidenceFragment[]): string {
  return hashText(JSON.stringify(fragments.map(f => ({
    path: f.relativePath, startLine: f.startLine, endLine: f.endLine, snippetHash: f.snippetHash
  }))))
}

/** 只取前 count 个候选组成最终证据包；指纹随之重算。 */
export function takeEvidencePrefix(pkg: EvidencePackage, count: number): EvidencePackage {
  const fragments = pkg.fragments.slice(0, count)
  return { ...pkg, fragments, fingerprint: fingerprintOf(fragments) }
}

async function readSourceSlice(
  workspaceRoot: string,
  relativePath: string,
  startLine: number,
  endLine: number
): Promise<{ text: string; startLine: number } | null> {
  const cache = createCanonicalPathCache()
  const rootCanon = canonicalizeExistingPath(resolve(workspaceRoot), cache)
  if (!rootCanon.ok) return null
  const target = canonicalizeExistingPath(join(rootCanon.path, relativePath.split('/').join(sep)), cache)
  if (!target.ok || !isPathWithinRoot(rootCanon.path, target.path)) return null
  const capped = await readCappedText(target.path, LEARNING_EVIDENCE_PER_FILE_MAX_BYTES)
  if (!capped) return null
  const slice = sliceLines(capped.text, startLine, endLine)
  return { text: slice.text, startLine: slice.startLine }
}

/** 发布前复查：只比较记录行范围内的片段，文件别处的改动不算出处失效。 */
export async function verifyFragmentAgainstDisk(
  workspaceRoot: string,
  fragment: Pick<EvidenceFragment, 'relativePath' | 'startLine' | 'endLine' | 'snippetHash'>
): Promise<boolean> {
  try {
    const slice = await readSourceSlice(workspaceRoot, fragment.relativePath, fragment.startLine, fragment.endLine)
    return slice !== null && hashText(slice.text) === fragment.snippetHash
  } catch {
    return false
  }
}

export async function readKnowledgeSource(
  workspaceRoot: string,
  source: import('../../../../shared/learning/knowledgeProjection').KnowledgeNodeSourceView
): Promise<import('../../../../shared/learning/surface').LearningSourceResult> {
  try {
    if (isSensitiveRelativePath(source.filePath) || (await loadIgnoreMatcher(workspaceRoot))(source.filePath, false)) {
      return { ok: false, reason: 'denied', message: '这个文件不允许读取' }
    }
    const slice = await readSourceSlice(workspaceRoot, source.filePath, source.startLine, source.endLine)
    if (!slice) return { ok: false, reason: 'missing', message: '找不到这段代码了' }
    return { ok: true, filePath: source.filePath, startLine: slice.startLine,
      text: slice.text, changed: hashText(slice.text) !== source.snippetHash }
  } catch (error) {
    return { ok: false, reason: 'missing', message: error instanceof Error ? error.message : String(error) }
  }
}
