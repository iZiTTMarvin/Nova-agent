export const LEARNING_EVIDENCE_STRATEGY_VERSION = 'learning-evidence-v1'

export interface EvidenceFragment {
  readonly sourceId: string
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly snippetText: string
  readonly contentHash: string
  readonly snippetHash: string
  readonly symbolLabel: string | null
  readonly collectedAt: number
}

export interface EvidencePackage {
  readonly projectId: string
  readonly workspaceRoot: string
  readonly strategyVersion: string
  readonly fragments: readonly EvidenceFragment[]
  readonly unreadPaths: readonly string[]
  readonly fingerprint: string
}

/** 可选索引查询；默认 null，不启动 Code Index。 */
export interface LearningCodeIndexQueryPort {
  findRelevantPaths?(hints: readonly string[]): Promise<readonly string[]>
}
