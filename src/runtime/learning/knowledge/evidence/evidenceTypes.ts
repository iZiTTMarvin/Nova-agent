/** 取证策略版本；排序、片段切取或核对口径变化时递增。 */
export const LEARNING_EVIDENCE_STRATEGY_VERSION = 'learning-evidence-v2'

export interface EvidenceFragment {
  readonly sourceId: string
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly snippetText: string
  readonly contentHash: string
  /** 发布与打开出处时只比较这个 hash：片段范围外的改动不算出处失效。 */
  readonly snippetHash: string
  readonly symbolLabel: string | null
  readonly collectedAt: number
}

/** 两层目录概览，只说明项目规模，不能作为事实出处。 */
export interface ProjectLayoutEntry {
  readonly dir: string
  readonly fileCount: number
}

export interface EvidencePackage {
  readonly projectId: string
  readonly workspaceRoot: string
  readonly strategyVersion: string
  /** 已按优先级排序；装箱时只取前缀。 */
  readonly fragments: readonly EvidenceFragment[]
  readonly projectLayout: readonly ProjectLayoutEntry[]
  readonly fingerprint: string
}
