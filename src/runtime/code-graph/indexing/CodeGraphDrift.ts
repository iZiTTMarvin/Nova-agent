import type {
  CodeGraphFileMetadataUpdate,
  CodeGraphFileRecord
} from '../graph/CodeGraphRepository'
import type { DiscoveredCodeFile } from './FileDiscovery'

export interface CodeGraphDriftPlan {
  readonly changedFiles: readonly DiscoveredCodeFile[]
  readonly removedPaths: readonly string[]
  readonly metadataUpdates: readonly CodeGraphFileMetadataUpdate[]
}

export type CodeGraphContentHashReader = (path: string) => Promise<string>

export async function planCodeGraphDrift(
  discoveredFiles: readonly DiscoveredCodeFile[],
  indexedFiles: readonly CodeGraphFileRecord[],
  readContentHash: CodeGraphContentHashReader
): Promise<CodeGraphDriftPlan> {
  const discoveredByPath = uniqueDiscoveredFiles(discoveredFiles)
  const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]))
  const changedFiles: DiscoveredCodeFile[] = []
  const metadataUpdates: CodeGraphFileMetadataUpdate[] = []

  for (const current of discoveredByPath.values()) {
    const comparison = await compareDiscoveredCodeFile(
      current,
      indexedByPath.get(current.path) ?? null,
      readContentHash
    )
    if (comparison.kind === 'changed') changedFiles.push(current)
    if (comparison.kind === 'metadata-only') metadataUpdates.push(comparison.update)
  }

  const removedPaths = indexedFiles
    .filter((file) => !discoveredByPath.has(file.path))
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, 'en'))
  changedFiles.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  metadataUpdates.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return Object.freeze({
    changedFiles: Object.freeze(changedFiles),
    removedPaths: Object.freeze(removedPaths),
    metadataUpdates: Object.freeze(metadataUpdates)
  })
}

export type CodeGraphFileComparison =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'metadata-only'; readonly update: CodeGraphFileMetadataUpdate }

export async function compareDiscoveredCodeFile(
  current: DiscoveredCodeFile,
  indexed: CodeGraphFileRecord | null,
  readContentHash: CodeGraphContentHashReader
): Promise<CodeGraphFileComparison> {
  if (!indexed) return Object.freeze({ kind: 'changed' })
  if (indexed.sizeBytes === current.sizeBytes && indexed.mtimeMs === current.mtimeMs) {
    return Object.freeze({ kind: 'unchanged' })
  }
  if (current.status !== 'eligible') return Object.freeze({ kind: 'changed' })

  const contentHash = await readContentHash(current.path)
  if (contentHash !== indexed.contentHash) return Object.freeze({ kind: 'changed' })
  return Object.freeze({
    kind: 'metadata-only',
    update: Object.freeze({
      path: current.path,
      contentHash,
      sizeBytes: current.sizeBytes,
      mtimeMs: current.mtimeMs
    })
  })
}

function uniqueDiscoveredFiles(
  files: readonly DiscoveredCodeFile[]
): ReadonlyMap<string, DiscoveredCodeFile> {
  const byPath = new Map<string, DiscoveredCodeFile>()
  for (const file of files) {
    if (byPath.has(file.path)) throw new Error(`重复发现代码文件：${file.path}`)
    byPath.set(file.path, file)
  }
  return byPath
}
