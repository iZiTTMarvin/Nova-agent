import { createHash, randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  LEARNING_EVIDENCE_PER_FILE_MAX_BYTES,
  LEARNING_SKELETON_MAX_EVIDENCE_FRAGMENTS,
  LEARNING_EVIDENCE_TOTAL_MAX_BYTES,
  LEARNING_DISCOVERY_MAX_ENTRIES
} from '../../../../shared/learning/buildLimits'
import {
  canonicalizeExistingPath,
  createCanonicalPathCache,
  isPathWithinRoot,
  lexicalNormalize,
  toWorkspaceRelativePath
} from '../../../permissions/pathAccess'
import { isPathSkipped, loadIgnoreMatcher } from '../../../workspace'
import type { EvidenceFragment, EvidencePackage, LearningCodeIndexQueryPort } from './evidenceTypes'
import { LEARNING_EVIDENCE_STRATEGY_VERSION } from './evidenceTypes'
import { isSensitiveRelativePath } from './sensitivePaths'
import { deriveProjectId } from '../../storage/workerCommand'
import { normalizeWorkspaceForProject } from '../../storage/workerCommand'

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yaml',
  '.yml'
])

const ENTRY_PRIORITY = ['package.json', 'README.md', 'readme.md', 'README.MD']
const MAX_FRAGMENT_BYTES = Math.min(LEARNING_EVIDENCE_PER_FILE_MAX_BYTES, Math.floor(LEARNING_EVIDENCE_TOTAL_MAX_BYTES / LEARNING_SKELETON_MAX_EVIDENCE_FRAGMENTS))

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 只读取上限内的前缀；指纹覆盖已读字节，不把未读尾部算进文件 hash。 */
async function readCappedText(
  absPath: string,
  maxBytes: number
): Promise<{ text: string } | null> {
  const handle = await open(absPath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const toRead = Math.min(stat.size, maxBytes)
    const buf = Buffer.alloc(toRead)
    if (toRead > 0) {
      await handle.read(buf, 0, toRead, 0)
    }
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
      found.push(rel)
    }
  }

  await walk(rootCanon.path)
  return found
}

const FLOW_ENTRY_PATTERN = /(?:^|\/)(index|main|app|save)\.(tsx?|jsx?|mjs|cjs)$/i

function prioritizePaths(paths: readonly string[]): string[] {
  const set = new Set(paths)
  const ordered: string[] = []
  for (const entry of ENTRY_PRIORITY) {
    if (set.has(entry)) ordered.push(entry)
  }
  const rest = [...paths].filter(p => !ordered.includes(p))
  const flowLike = rest.filter(p => FLOW_ENTRY_PATTERN.test(p.replace(/\\/g, '/'))).sort()
  const other = rest.filter(p => !FLOW_ENTRY_PATTERN.test(p.replace(/\\/g, '/'))).sort()
  return [...ordered, ...flowLike, ...other]
}

function sliceFragmentLines(
  content: string,
  startLine: number,
  endLine: number
): { text: string; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, startLine)
  const end = Math.min(lines.length, endLine)
  if (start > lines.length) {
    return { text: '', startLine: start, endLine: start }
  }
  const text = lines.slice(start - 1, end).join('\n')
  return { text, startLine: start, endLine: end }
}

export class WorkspaceEvidencePort {
  constructor(private readonly codeIndex: LearningCodeIndexQueryPort | null = null) {}

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

    let candidates = prioritizePaths(await listReadableFiles(normalizedRoot, params.signal))
    if (params.focusRelativePaths?.length) {
      const focus = params.focusRelativePaths.map(p => p.replace(/\\/g, '/'))
      const focusSet = new Set(focus)
      const prioritized = candidates.filter(p => focusSet.has(p))
      const rest = candidates.filter(p => !focusSet.has(p))
      candidates = [...prioritized, ...rest]
    }

    if (this.codeIndex?.findRelevantPaths) {
      try {
        const hinted = await this.codeIndex.findRelevantPaths(['save', 'entry', 'main'])
        const hintSet = new Set(hinted.map(p => p.replace(/\\/g, '/')))
        const hintedFirst = candidates.filter(p => hintSet.has(p))
        const rest = candidates.filter(p => !hintSet.has(p))
        if (hintedFirst.length > 0) candidates = [...hintedFirst, ...rest]
      } catch {
        // 索引不可用时继续文件枚举
      }
    }

    const fragments: EvidenceFragment[] = []
    const perFileBytes = new Map<string, number>()
    const collectedAt = Date.now()

    for (const relPath of candidates) {
      params.signal?.throwIfAborted()
      if (fragments.length >= LEARNING_SKELETON_MAX_EVIDENCE_FRAGMENTS) break
      const absPath = join(rootCanon.path, relPath.split('/').join(sep))
      const targetCanon = canonicalizeExistingPath(absPath, cache)
      if (!targetCanon.ok || !isPathWithinRoot(rootCanon.path, targetCanon.path)) continue

      const used = perFileBytes.get(relPath) ?? 0
      if (used >= LEARNING_EVIDENCE_PER_FILE_MAX_BYTES) continue

      let capped: { text: string } | null
      try {
        capped = await readCappedText(
          targetCanon.path,
          MAX_FRAGMENT_BYTES
        )
      } catch {
        continue
      }
      if (!capped) continue

      perFileBytes.set(relPath, used + Buffer.byteLength(capped.text, 'utf8'))
      const content = capped.text
      const contentHash = hashText(content)
      const lineCount = content.split(/\r?\n/).length
      const endLine = Math.max(1, lineCount)
      const { text, startLine, endLine: end } = sliceFragmentLines(content, 1, endLine)

      fragments.push({
        sourceId: randomUUID(),
        relativePath: relPath,
        startLine,
        endLine: end,
        snippetText: text,
        contentHash,
        snippetHash: hashText(text),
        symbolLabel: null,
        collectedAt
      })
    }

    const readSet = new Set(fragments.map(f => f.relativePath))
    const unreadPaths = candidates.filter(p => !readSet.has(p))

    const fingerprint = hashText(
      JSON.stringify(
        fragments.map(f => ({
          id: f.sourceId,
          path: f.relativePath,
          contentHash: f.contentHash,
          snippetHash: f.snippetHash
        }))
      )
    )

    return {
      projectId,
      workspaceRoot: normalizedRoot,
      strategyVersion: LEARNING_EVIDENCE_STRATEGY_VERSION,
      fragments,
      unreadPaths,
      fingerprint
    }
  }
}

/** 发布前复查：片段仍来自当前文件字节。 */
export async function verifyFragmentAgainstDisk(
  workspaceRoot: string,
  fragment: Pick<
    EvidenceFragment,
    'relativePath' | 'startLine' | 'endLine' | 'contentHash' | 'snippetHash'
  >
): Promise<boolean> {
  const cache = createCanonicalPathCache()
  const rootCanon = canonicalizeExistingPath(resolve(workspaceRoot), cache)
  if (!rootCanon.ok) return false
  const absPath = join(rootCanon.path, fragment.relativePath.split('/').join(sep))
  const targetCanon = canonicalizeExistingPath(absPath, cache)
  if (!targetCanon.ok || !isPathWithinRoot(rootCanon.path, targetCanon.path)) return false
  let capped: { text: string } | null
  try {
    capped = await readCappedText(targetCanon.path, MAX_FRAGMENT_BYTES)
  } catch {
    return false
  }
  if (!capped || hashText(capped.text) !== fragment.contentHash) return false
  const content = capped.text
  const { text } = sliceFragmentLines(content, fragment.startLine, fragment.endLine)
  return hashText(text) === fragment.snippetHash
}

export async function readKnowledgeSource(
  workspaceRoot: string,
  source: import('../../../../shared/learning/knowledgeProjection').KnowledgeNodeSourceView
): Promise<import('../../../../shared/learning/surface').LearningSourceResult> {
  try {
    if (isSensitiveRelativePath(source.filePath) || (await loadIgnoreMatcher(workspaceRoot))(source.filePath, false)) {
      return { ok: false, message: '来源已被当前项目的读取策略排除' }
    }
    const cache = createCanonicalPathCache()
    const root = canonicalizeExistingPath(resolve(workspaceRoot), cache)
    const target = canonicalizeExistingPath(resolve(workspaceRoot, source.filePath), cache)
    if (!root.ok || !target.ok || !isPathWithinRoot(root.path, target.path)) {
      return { ok: false, message: '来源已删除、不可访问或不在授权工作区中' }
    }
    const content = await readCappedText(target.path, MAX_FRAGMENT_BYTES)
    if (!content) return { ok: false, message: '来源不是可读文本' }
    const snippet = sliceFragmentLines(content.text, source.startLine, source.endLine)
    return { ok: true, filePath: source.filePath, startLine: snippet.startLine,
      text: snippet.text, changed: hashText(snippet.text) !== source.snippetHash }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
