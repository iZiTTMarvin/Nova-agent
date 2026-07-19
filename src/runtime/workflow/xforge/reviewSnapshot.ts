import { readFile, stat } from 'fs/promises'
import {
  compareFileEffects,
  hashContent,
  listFileEffectsDetailedAsync,
  resolveBackupRef,
  type FileEffectReceipt
} from '../v2/EffectReceipt'
import {
  canonicalizeRoot,
  isPathInside,
  resolveExistingPathUnderRoot
} from '../pathSafety'
import { isPathAllowedByChangeScope, normalizeWorkspaceRelativePath } from './changeScope'
import type { XForgeEvidenceRef } from './runState'
import { getXForgeRunRoot, writeXForgeEvidenceAsync } from './stageArtifacts'
import {
  hashWorkspaceFile,
  isRuntimeGeneratedPath,
  isSensitiveReviewPath,
  listDirtyWorkspaceEntries,
  readHeadOid,
  readTrackedFileAtHead,
  type XForgeReviewTarget,
  type XForgeWorkspaceBaselineV1
} from './workspaceBaseline'

export interface XForgeReviewSnapshotFile {
  path: string
  content: string
  beforeContent?: string
}

export interface XForgeReviewWorkspaceSnapshot {
  changedFiles: string[]
  files: XForgeReviewSnapshotFile[]
  diff: string
  evidenceRef: XForgeEvidenceRef
  targetKind: XForgeReviewTarget['kind']
}

export interface BuildXForgeReviewSnapshotParams {
  workspaceRoot: string
  runId: string
  baseline: XForgeWorkspaceBaselineV1 | null | undefined
  reviewTarget: XForgeReviewTarget | null | undefined
  changeScope: readonly string[] | null | undefined
}

const MAX_REVIEW_FILES = 200
const MAX_REVIEW_BYTES = 2 * 1024 * 1024

export async function buildXForgeReviewSnapshot(
  params: BuildXForgeReviewSnapshotParams
): Promise<{ snapshot?: XForgeReviewWorkspaceSnapshot; blockedReason?: string }> {
  try {
    if (!params.baseline || params.baseline.schemaVersion !== 1) {
      return {
        blockedReason:
          '缺少不可变 Workspace Baseline，无法安全构建 Review Snapshot；请重新开始该 XForge run'
      }
    }
    if (!params.reviewTarget) {
      return { blockedReason: '缺少 Review Target，无法决定审查对象；请重新开始该 XForge run' }
    }

    const root = await canonicalizeRoot(params.workspaceRoot)
    if (params.reviewTarget.kind === 'existing_worktree') {
      return await buildExistingWorktreeSnapshot({
        workspaceRoot: root,
        runId: params.runId,
        baseline: params.baseline
      })
    }
    return await buildRunEffectsSnapshot({
      workspaceRoot: root,
      runId: params.runId,
      baseline: params.baseline,
      changeScope: params.changeScope
    })
  } catch (error) {
    return { blockedReason: error instanceof Error ? error.message : String(error) }
  }
}

async function buildRunEffectsSnapshot(params: {
  workspaceRoot: string
  runId: string
  baseline: XForgeWorkspaceBaselineV1
  changeScope: readonly string[] | null | undefined
}): Promise<{ snapshot?: XForgeReviewWorkspaceSnapshot; blockedReason?: string }> {
  if (!params.changeScope || params.changeScope.length === 0) {
    return { blockedReason: 'run_effects Review 缺少 validatedPlan.changeScope' }
  }
  const headDrift = await detectHeadDrift(params.workspaceRoot, params.baseline, 'run_effects')
  if (headDrift) return { blockedReason: headDrift }

  const listed = await listFileEffectsDetailedAsync(params.workspaceRoot, params.runId)
  if (listed.corruptIds.length > 0) {
    return {
      blockedReason: `存在损坏的 EffectReceipt，拒绝构建 Review Snapshot: ${listed.corruptIds.join(', ')}`
    }
  }
  const prepared = listed.effects.filter(effect => effect.status !== 'committed')
  if (prepared.length > 0) {
    return {
      blockedReason: `存在未收口的 prepared EffectReceipt，拒绝构建 Review Snapshot: ${prepared
        .map(effect => effect.path)
        .join(', ')}`
    }
  }

  const byPath = groupReceiptsByPath(listed.effects)
  const changedFiles = [...byPath.keys()].sort()
  if (changedFiles.length > MAX_REVIEW_FILES) {
    return { blockedReason: `变更文件数 ${changedFiles.length} 超过 Review Snapshot 上限 ${MAX_REVIEW_FILES}` }
  }
  const sensitive = changedFiles.find(isSensitiveReviewPath)
  if (sensitive) {
    return { blockedReason: `Review Snapshot 包含敏感文件，拒绝读取: ${sensitive}` }
  }

  for (const [path, receipts] of byPath) {
    if (!isPathAllowedByChangeScope(path, params.changeScope)) {
      return { blockedReason: `EffectReceipt 越过 changeScope: ${path}` }
    }
    const chainError = await validateReceiptChain(params.workspaceRoot, params.runId, path, receipts)
    if (chainError) return { blockedReason: chainError }
  }

  const driftError = await detectUnreceiptedDrift({
    workspaceRoot: params.workspaceRoot,
    baseline: params.baseline,
    receiptPaths: new Set(byPath.keys())
  })
  if (driftError) return { blockedReason: driftError }

  let remainingBytes = MAX_REVIEW_BYTES
  const files: XForgeReviewSnapshotFile[] = []
  const diffChunks: string[] = []
  for (const path of changedFiles) {
    const receipts = byPath.get(path)!
    const built = await readRunEffectFile({
      workspaceRoot: params.workspaceRoot,
      runId: params.runId,
      path,
      first: receipts[0]!,
      last: receipts[receipts.length - 1]!,
      maxBytes: remainingBytes
    })
    if ('blockedReason' in built) return built
    remainingBytes -= built.bytes
    files.push(built.file)
    diffChunks.push(renderPairDiff(path, built.file.beforeContent ?? '', built.file.content))
  }

  const finalHeadDrift = await detectHeadDrift(params.workspaceRoot, params.baseline, 'run_effects')
  if (finalHeadDrift) return { blockedReason: finalHeadDrift }

  return finalizeSnapshot({
    workspaceRoot: params.workspaceRoot,
    runId: params.runId,
    targetKind: 'run_effects',
    changedFiles,
    files,
    diff: diffChunks.join('\n')
  })
}

async function buildExistingWorktreeSnapshot(params: {
  workspaceRoot: string
  runId: string
  baseline: XForgeWorkspaceBaselineV1
}): Promise<{ snapshot?: XForgeReviewWorkspaceSnapshot; blockedReason?: string }> {
  const headDrift = await detectHeadDrift(params.workspaceRoot, params.baseline, 'existing_worktree')
  if (headDrift) return { blockedReason: headDrift }

  const changedFiles = params.baseline.entries.map(entry => entry.path).sort()
  if (changedFiles.length > MAX_REVIEW_FILES) {
    return { blockedReason: `变更文件数 ${changedFiles.length} 超过 Review Snapshot 上限 ${MAX_REVIEW_FILES}` }
  }
  const sensitive = changedFiles.find(isSensitiveReviewPath)
  if (sensitive) {
    return { blockedReason: `Review Snapshot 包含敏感文件，拒绝读取: ${sensitive}` }
  }

  let remainingBytes = MAX_REVIEW_BYTES
  const files: XForgeReviewSnapshotFile[] = []
  const diffChunks: string[] = []
  for (const entry of params.baseline.entries) {
    const current = await readCurrentReviewFile(params.workspaceRoot, entry.path, remainingBytes)
    if ('blockedReason' in current) return current
    if (current.contentHash !== entry.contentHash) {
      return { blockedReason: `existing_worktree 冻结路径已漂移: ${entry.path}；请重新建立审查 run` }
    }
    remainingBytes -= current.bytes

    let beforeContent = ''
    if (entry.kind === 'tracked' && params.baseline.headOid) {
      const headFile = await readTrackedFileAtHead(
        params.workspaceRoot,
        entry.path,
        remainingBytes,
        params.baseline.headOid
      )
      if (headFile?.binary) {
        return { blockedReason: `Review Snapshot 不允许省略二进制文件: ${entry.path}` }
      }
      if (headFile) {
        beforeContent = headFile.content
        remainingBytes -= Buffer.byteLength(beforeContent, 'utf8')
      }
    }

    const file: XForgeReviewSnapshotFile = {
      path: entry.path,
      content: current.file.content,
      beforeContent
    }
    files.push(file)
    diffChunks.push(renderPairDiff(entry.path, beforeContent, current.file.content))
  }

  const finalHeadDrift = await detectHeadDrift(
    params.workspaceRoot,
    params.baseline,
    'existing_worktree'
  )
  if (finalHeadDrift) return { blockedReason: finalHeadDrift }

  return finalizeSnapshot({
    workspaceRoot: params.workspaceRoot,
    runId: params.runId,
    targetKind: 'existing_worktree',
    changedFiles,
    files,
    diff: diffChunks.join('\n')
  })
}

async function detectHeadDrift(
  workspaceRoot: string,
  baseline: XForgeWorkspaceBaselineV1,
  target: XForgeReviewTarget['kind']
): Promise<string | null> {
  const currentHead = await readHeadOid(workspaceRoot)
  return (currentHead ?? null) === (baseline.headOid ?? null)
    ? null
    : `${target} Review 期间 HEAD 已漂移，请重新建立审查 run`
}

async function detectUnreceiptedDrift(params: {
  workspaceRoot: string
  baseline: XForgeWorkspaceBaselineV1
  receiptPaths: Set<string>
}): Promise<string | null> {
  const baselineByPath = new Map(params.baseline.entries.map(entry => [entry.path, entry]))
  const currentEntries = await listDirtyWorkspaceEntries(params.workspaceRoot)
  const currentByPath = new Map(currentEntries.map(entry => [entry.path, entry]))

  for (const current of currentEntries) {
    if (isRuntimeGeneratedPath(current.path)) continue
    const baseline = baselineByPath.get(current.path)
    if (baseline && baseline.contentHash === current.contentHash) continue
    if (!params.receiptPaths.has(current.path)) {
      return `检测到无 EffectReceipt 的工作区漂移，拒绝归入 XForge Review: ${current.path}`
    }
  }
  for (const baseline of params.baseline.entries) {
    if (isRuntimeGeneratedPath(baseline.path) || baseline.contentHash === null) continue
    if (currentByPath.has(baseline.path)) continue
    if (!params.receiptPaths.has(baseline.path)) {
      return `检测到无 EffectReceipt 的文件删除漂移，拒绝归入 XForge Review: ${baseline.path}`
    }
  }
  return null
}

function groupReceiptsByPath(receipts: FileEffectReceipt[]): Map<string, FileEffectReceipt[]> {
  const map = new Map<string, FileEffectReceipt[]>()
  for (const receipt of receipts) {
    const path = normalizeWorkspaceRelativePath(receipt.path)
    const list = map.get(path) ?? []
    list.push(receipt)
    map.set(path, list)
  }
  for (const list of map.values()) list.sort(compareFileEffects)
  return map
}

async function validateReceiptChain(
  workspaceRoot: string,
  runId: string,
  path: string,
  receipts: FileEffectReceipt[]
): Promise<string | null> {
  const sequences = receipts.map(receipt => receipt.sequence)
  const presentSequences = sequences.filter((value): value is number => value !== undefined)
  if (new Set(presentSequences).size !== presentSequences.length) {
    return `EffectReceipt sequence 重复，无法证明写入顺序: ${path}`
  }
  if (receipts.length > 1 && presentSequences.length !== receipts.length) {
    const timestamps = receipts.map(receipt => receipt.at)
    if (new Set(timestamps).size !== timestamps.length) {
      return `旧 EffectReceipt 时间戳冲突，无法证明写入顺序: ${path}`
    }
  }

  for (let index = 1; index < receipts.length; index += 1) {
    const prev = receipts[index - 1]!
    const next = receipts[index]!
    if (prev.afterHash !== next.beforeHash) {
      return `EffectReceipt 链断裂: ${path}（前一条 afterHash 与后一条 beforeHash 不一致）`
    }
  }

  const first = receipts[0]!
  if (first.action !== 'create') {
    const backup = await readBackupFile(workspaceRoot, runId, first.beforeCheckpointRef, path, MAX_REVIEW_BYTES)
    if ('blockedReason' in backup) return backup.blockedReason
    if (first.beforeHash !== null && hashContent(backup.buffer) !== first.beforeHash) {
      return `写前备份哈希不符: ${path}`
    }
  }

  const last = receipts[receipts.length - 1]!
  const currentHash = await hashWorkspaceFile(workspaceRoot, path, MAX_REVIEW_BYTES)
  if (last.action === 'delete') {
    return currentHash === null ? null : `删除后的文件仍存在，疑似并发漂移: ${path}`
  }
  if (last.afterHash === null) return `committed EffectReceipt 缺少 afterHash: ${path}`
  return currentHash === last.afterHash
    ? null
    : `当前文件哈希与最后一条 EffectReceipt.afterHash 不符（并发漂移）: ${path}`
}

async function readRunEffectFile(params: {
  workspaceRoot: string
  runId: string
  path: string
  first: FileEffectReceipt
  last: FileEffectReceipt
  maxBytes: number
}): Promise<
  | { file: XForgeReviewSnapshotFile; bytes: number }
  | { blockedReason: string }
> {
  let beforeContent = ''
  let bytes = 0
  if (params.first.action !== 'create') {
    const backup = await readBackupFile(
      params.workspaceRoot,
      params.runId,
      params.first.beforeCheckpointRef,
      params.path,
      params.maxBytes
    )
    if ('blockedReason' in backup) return backup
    if (backup.buffer.includes(0)) {
      return { blockedReason: `Review Snapshot 不允许省略二进制文件: ${params.path}` }
    }
    beforeContent = backup.buffer.toString('utf8')
    bytes += backup.buffer.length
  }

  if (params.last.action === 'delete') {
    return {
      file: { path: params.path, content: '', beforeContent },
      bytes
    }
  }
  const current = await readCurrentReviewFile(
    params.workspaceRoot,
    params.path,
    params.maxBytes - bytes
  )
  if ('blockedReason' in current) return current
  if (params.last.afterHash !== current.contentHash) {
    return { blockedReason: `Review 读取期间文件已漂移: ${params.path}` }
  }
  return {
    file: { path: params.path, content: current.file.content, beforeContent },
    bytes: bytes + current.bytes
  }
}

async function readCurrentReviewFile(
  workspaceRoot: string,
  relativePath: string,
  maxBytes: number
): Promise<
  | { file: XForgeReviewSnapshotFile; bytes: number; contentHash: string | null }
  | { blockedReason: string }
> {
  if (maxBytes < 0) return { blockedReason: `Review Snapshot 文件正文超过 ${MAX_REVIEW_BYTES} 字节上限` }
  const resolved = await resolveExistingPathUnderRoot(workspaceRoot, relativePath)
  if (!resolved) {
    return {
      file: { path: relativePath, content: '' },
      bytes: 0,
      contentHash: null
    }
  }
  if (!resolved.stats.isFile()) {
    return { blockedReason: `Review Snapshot 路径不是普通文件: ${relativePath}` }
  }
  if (resolved.stats.size > maxBytes) {
    return { blockedReason: `Review Snapshot 文件正文超过 ${MAX_REVIEW_BYTES} 字节上限: ${relativePath}` }
  }
  const buffer = await readFile(resolved.absolutePath)
  if (buffer.length > maxBytes) {
    return { blockedReason: `Review Snapshot 文件正文超过 ${MAX_REVIEW_BYTES} 字节上限: ${relativePath}` }
  }
  if (buffer.includes(0)) {
    return { blockedReason: `Review Snapshot 不允许省略二进制文件: ${relativePath}` }
  }
  return {
    file: {
      path: normalizeWorkspaceRelativePath(relativePath),
      content: buffer.toString('utf8')
    },
    bytes: buffer.length,
    contentHash: hashContent(buffer)
  }
}

async function readBackupFile(
  workspaceRoot: string,
  runId: string,
  backupRef: string | null,
  reviewPath: string,
  maxBytes: number
): Promise<{ buffer: Buffer } | { blockedReason: string }> {
  let backupAbs: string | null
  try {
    backupAbs = resolveBackupRef(workspaceRoot, runId, backupRef)
  } catch (error) {
    return { blockedReason: error instanceof Error ? error.message : String(error) }
  }
  if (!backupAbs) return { blockedReason: `写前备份缺失: ${reviewPath}` }

  const runRoot = await canonicalizeRoot(getXForgeRunRoot(workspaceRoot, runId))
  const canonicalBackup = await canonicalizeRoot(backupAbs).catch(() => null)
  if (!canonicalBackup || !isPathInside(runRoot, canonicalBackup)) {
    return { blockedReason: `写前备份缺失或越界: ${reviewPath}` }
  }
  const backupStats = await stat(canonicalBackup)
  if (!backupStats.isFile() || backupStats.size > maxBytes) {
    return { blockedReason: `写前备份不可审查或超过大小上限: ${reviewPath}` }
  }
  const buffer = await readFile(canonicalBackup)
  if (buffer.length > maxBytes) {
    return { blockedReason: `写前备份超过大小上限: ${reviewPath}` }
  }
  return { buffer }
}

function renderPairDiff(path: string, beforeContent: string, afterContent: string): string {
  const beforeLines = beforeContent.split('\n')
  const afterLines = afterContent.split('\n')
  return [
    `diff -- ${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ before ${beforeLines.length} lines / after ${afterLines.length} lines @@`,
    ...beforeLines.map(line => `- ${line}`),
    ...afterLines.map(line => `+ ${line}`)
  ].join('\n')
}

async function finalizeSnapshot(params: {
  workspaceRoot: string
  runId: string
  targetKind: XForgeReviewTarget['kind']
  changedFiles: string[]
  files: XForgeReviewSnapshotFile[]
  diff: string
}): Promise<{ snapshot: XForgeReviewWorkspaceSnapshot }> {
  const evidenceRef = await writeXForgeEvidenceAsync({
    workspaceRoot: params.workspaceRoot,
    runId: params.runId,
    kind: 'review-input',
    name: 'review-input',
    content: [
      '# Review Input Snapshot',
      `- Target: ${params.targetKind}`,
      ...params.changedFiles.map(file => `- ${file}`),
      '',
      '```diff',
      params.diff.replace(/```/g, '``\u200b`'),
      '```'
    ].join('\n')
  })
  return {
    snapshot: {
      changedFiles: params.changedFiles,
      files: params.files,
      diff: params.diff,
      evidenceRef,
      targetKind: params.targetKind
    }
  }
}
