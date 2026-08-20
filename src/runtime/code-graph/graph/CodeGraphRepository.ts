import type {
  CodeEvidenceConfidence,
  CodeFileEdgeKind,
  CodeFileParseStatus,
  CodeGraphLanguage,
  CodeIndexCoverage,
  CodeIndexOperation,
  CodeRelationResolver,
  CodeSymbolEdgeKind,
  CodeSymbolKind,
  CodeUnresolvedReason,
  CodeUnresolvedRelationKind
} from '../types'

export interface CodeGraphMetadata {
  readonly schemaVersion: number
  readonly workspaceIdentity: string
  readonly activeGeneration: number | null
  readonly revision: number
  readonly parserSignature: string
  readonly resolverSignature: string
  readonly lastCompletedAt: number | null
  readonly lastAccessed: number
}

export interface CodeGraphFileInput {
  readonly path: string
  readonly language: CodeGraphLanguage
  readonly contentHash: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly lineCount: number
  readonly parseStatus: CodeFileParseStatus
}

export interface CodeGraphFileRecord extends CodeGraphFileInput {
  readonly id: number
  readonly generation: number
}

export interface CodeGraphSymbolInput {
  readonly stableId: string
  readonly filePath: string
  readonly name: string
  readonly qualifiedName: string
  readonly kind: CodeSymbolKind
  readonly exported: boolean
  readonly signature: string | null
  readonly docExcerpt: string | null
  readonly identifierTokens: string
  readonly startLine: number
  readonly endLine: number
  readonly startByte: number
  readonly endByte: number
}

export interface CodeGraphFileEdgeInput {
  readonly sourcePath: string
  readonly targetPath: string
  readonly kind: CodeFileEdgeKind
  readonly confidence: CodeEvidenceConfidence
  readonly resolver: CodeRelationResolver
  readonly sourceLine: number
}

export interface CodeGraphSymbolEdgeInput {
  readonly sourceSymbolId: string
  readonly targetSymbolId: string
  readonly kind: CodeSymbolEdgeKind
  readonly confidence: CodeEvidenceConfidence
  readonly resolver: CodeRelationResolver
  readonly sourceFile: string
  readonly sourceLine: number
}

export interface CodeGraphUnresolvedRelationInput {
  readonly filePath: string
  readonly sourceSymbolId: string | null
  readonly kind: CodeUnresolvedRelationKind
  readonly rawTarget: string
  readonly moduleSpecifier: string | null
  readonly sourceLine: number
  readonly reason: CodeUnresolvedReason
  readonly resolver: CodeRelationResolver
}

export interface CodeGraphGenerationInput {
  readonly operationId: string
  readonly generation: number
  readonly parserSignature: string
  readonly resolverSignature: string
  readonly stagedAt: number
  readonly files: readonly CodeGraphFileInput[]
  readonly symbols: readonly CodeGraphSymbolInput[]
  readonly fileEdges: readonly CodeGraphFileEdgeInput[]
  readonly symbolEdges: readonly CodeGraphSymbolEdgeInput[]
  readonly unresolvedRelations: readonly CodeGraphUnresolvedRelationInput[]
}

export interface CodeGraphGenerationActivation {
  readonly operationId: string
  readonly workspaceIdentity: string
  readonly generation: number
  readonly expectedActiveGeneration: number | null
  readonly expectedRevision: number
  readonly completedAt: number
}

export interface CodeGraphIncrementalUpdate {
  readonly operationId: string
  readonly workspaceIdentity: string
  readonly generation: number
  readonly expectedRevision: number
  readonly completedAt: number
  readonly removedPaths: readonly string[]
  readonly files: readonly CodeGraphFileInput[]
  readonly symbols: readonly CodeGraphSymbolInput[]
  readonly fileEdges: readonly CodeGraphFileEdgeInput[]
  readonly symbolEdges: readonly CodeGraphSymbolEdgeInput[]
  readonly unresolvedRelations: readonly CodeGraphUnresolvedRelationInput[]
}

/** 代码图持久化端口；写入只接受 Coordinator 签发的 operation。 */
export interface CodeGraphRepository {
  getMetadata(): Promise<CodeGraphMetadata>
  nextGeneration(): Promise<number>
  /** 写入 fence 是数据库提交前的最终失效校验，不替代 Coordinator 状态。 */
  claimOperation(operation: CodeIndexOperation): Promise<void>
  releaseOperation(operation: CodeIndexOperation): Promise<void>
  getCoverage(generation?: number | null): Promise<CodeIndexCoverage>
  findActiveFile(path: string): Promise<CodeGraphFileRecord | null>
  stageGeneration(input: CodeGraphGenerationInput): Promise<void>
  activateGeneration(input: CodeGraphGenerationActivation): Promise<CodeGraphMetadata>
  applyIncrementalUpdate(input: CodeGraphIncrementalUpdate): Promise<CodeGraphMetadata>
  deleteGeneration(generation: number): Promise<void>
  touchAccess(accessedAt: number): Promise<void>
  close(): Promise<void>
}
