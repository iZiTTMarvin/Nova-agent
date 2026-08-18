/**
 * 记忆模块公共出口：仅导出端口类型与纯逻辑，不 re-export 原生实现。
 * 主进程请直接 import `@runtime/memory/BetterSqliteMemoryDb`。
 */

export type { MemoryDb, MemoryDbStatement } from './MemoryDb'
export { verifyTrigramFts5 } from './spikeVerify'
export type { TrigramSpikeResult } from './spikeVerify'
export {
  computeWorkspaceHash,
  getMemoryRoot,
  getProjectMemoryDir,
  getMemoryMdPath,
  getMemoryDbPath,
  parseScopeIdFromMemoryMdPath,
  parseScopeIdFromDirName,
  normalizeWorkspaceRoot,
  resolveSafeScopeRelPath,
  GLOBAL_SCOPE_ID,
  WORKSPACE_HASH_LENGTH
} from './MemoryPaths'
export { MemoryService, DEFAULT_L1_MAX_CHARS } from './MemoryService'
export type { MemoryServiceOptions } from './MemoryService'
export {
  applyL1Budget,
  applyL2Budget,
  DEFAULT_L2_MAX_CHARS,
  DEFAULT_L2_SNIPPET_MAX_CHARS,
  L2_HIT_SEPARATOR,
  MEMORY_PREFETCH_TOTAL_MAX_CHARS,
  MEMORY_PREFETCH_STRUCTURED_MAX_CHARS,
  MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS,
  MEMORY_PREFETCH_GLOBAL_MAX_ITEMS,
  MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS,
  MEMORY_PREFETCH_CANDIDATE_LIMIT,
  MEMORY_PREFETCH_SCORE_FLOOR
} from './MemoryBudget'
export { buildL1MemoryContext } from './MemoryInjector'
export {
  extractUserIntent,
  buildSearchQueryFromIntent,
  extractMemorySnippet,
  buildL2TailBlock,
  buildL2ContextMessage,
  createMemoryContextHook,
  L2_BLOCK_TITLE
} from './MemoryTailInjector'
export { truncateAtLineOrHeaderBoundary } from './truncateEssence'
export {
  buildMatchQuery,
  buildTrigramMatchQuery,
  buildUnicode61MatchQuery,
  applyScoreFloor,
  computeOverFetchLimit,
  computeFingerprint,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SCORE_FLOOR,
  TRIGRAM_MIN_QUERY_LEN
} from './FtsQueryBuilder'
export {
  planReconcileDiff,
  scanScopeMarkdownFiles,
  listScopeMarkdownFileMeta,
  reconcileScope
} from './MemoryReconciler'
export {
  filterPrivacyText,
  filterToolPayload,
  isSensitiveFilePath,
  PRIVACY_REDACTED
} from './PrivacyFilter'
export {
  ObservationCapture,
  getObservationCaptureForSession,
  removeObservationCaptureForSession,
  resetObservationCapturesForTests,
  buildObservationTitle,
  buildFilteredObservationTitle,
  truncateObservationTitle,
  extractObservationFacts,
  extractFilesTouched,
  computeObservationFingerprint,
  DEFAULT_MAX_BUFFER_SIZE
} from './ObservationCapture'
export type { MemoryObservation, FilteredObservationTitle } from './ObservationCapture'
export { subscribeObservationCapture } from './MemoryObservationBridge'
export {
  consolidateObservations,
  consolidateFallback,
  EPISODIC_SUMMARY_REL_PATH
} from './MemoryConsolidator'
export { initMemorySchema, listMemorySchemaObjects, MEMORY_FILES_SCOPE_PATH_IDX } from './MemorySchema'
export type {
  ScannedMemoryFile,
  ReconcilePlan,
  ReconcileStats,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryScopeFileEntry,
  MemoryScopeStats,
  BuiltMatchQuery,
  FtsQueryPath
} from './types'
export { MemoryExtractor, EXTRACT_REASONING_EFFORT } from './extraction/MemoryExtractor'
export type { MemoryExtractorDeps, MemoryExtractionInput } from './extraction/MemoryExtractor'
export {
  projectExtractionMessages,
  buildEvidenceProvenance,
  parseMemoryCandidateResponse
} from './extraction/MemoryExtractor'
export type { EvidenceProvenance, CandidateParseResult } from './extraction/MemoryExtractor'
export { decideMemoryPolicy, resolveCandidateScope, contentSimilarity } from './policy/MemoryPolicy'
export { MemoryCandidateProcessor } from './policy/MemoryCandidateProcessor'
export type {
  MemoryCandidateProcessInput,
  MemoryCandidateProcessCounts,
  MemoryCandidateProcessorDeps
} from './policy/MemoryCandidateProcessor'
export {
  MEMORY_EXTRACT_INTERVAL_TURNS,
  MEMORY_EXTRACT_WINDOW_SIZE,
  MEMORY_EVIDENCE_EXCERPT_MAX_CHARS,
  MEMORY_CANDIDATE_CONTENT_MAX_CHARS,
  MEMORY_KEY_MAX_CHARS,
  MEMORY_CONTENT_EQUIVALENCE_THRESHOLD,
  MEMORY_CONFIDENCE_STEP,
  MEMORY_CONFIDENCE_CAP,
  MEMORY_PROMOTION_PROJECT_MIN_SESSIONS,
  MEMORY_PROMOTION_GLOBAL_MIN_PROJECTS,
  MEMORY_INFERRED_MIN_CONFIDENCE,
  MEMORY_KEYLESS_RECALL_LIMIT
} from './memoryConfig'
export {
  migrateMemorySchema,
  readMemorySchemaVersion,
  MEMORY_SCHEMA_VERSION,
  MemoryMigrationError
} from './schema/MemoryMigrations'
export type {
  MemoryMigrationResult,
  MemoryMigrationDiagnostic,
  MemoryMigrationFailureCode
} from './schema/MemoryMigrations'
export type {
  MemoryRepository
} from './repository/MemoryRepository'
export type {
  MemoryRecordDraft,
  MemoryEvidenceDraft,
  MemoryRecordListOptions,
  MemoryStatusUpdateOptions,
  MemoryEvidenceMergeInput,
  MemoryFtsSearchOptions,
  MemoryFtsStatusFilter,
  MemoryRecordFtsHit,
  MemorySupersedeResult
} from './repository/MemoryRepository'
export type {
  MemoryHistoricalNote,
  StructuredMemoryResult,
  DocumentMemoryResult,
  MemorySearchResult,
  ScoredMemoryResult,
  MemorySearchInput,
  MemoryRetriever,
  MemoryVectorProvider
} from './retrieval/MemoryRetriever'
export { stripLexicalScore } from './retrieval/MemoryRetriever'
export { StructuredMemoryRetriever } from './retrieval/StructuredMemoryRetriever'
export { DocumentMemoryRetriever } from './retrieval/DocumentMemoryRetriever'
export type { DocumentMemorySearchPort } from './retrieval/DocumentMemoryRetriever'
export { MemoryRetrievalService } from './retrieval/MemoryRetrievalService'
export type { MemoryRetrievalServiceDeps } from './retrieval/MemoryRetrievalService'
export { MemoryPrefetchService, MEMORY_PREFETCH_BLOCK_TITLE, MEMORY_PREFETCH_RULES } from './retrieval/MemoryPrefetchService'
export type { MemoryPrefetchInput, MemoryPrefetchRetrievalPort } from './retrieval/MemoryPrefetchService'
export {
  rankMemoryResults,
  computeMemoryRankScore,
  scopeTierOf,
  kindRelevanceScore,
  freshnessScore,
  isEpisodicDocument,
  MEMORY_RANKING_WEIGHTS,
  MEMORY_FRESHNESS_HALF_LIFE_DAYS
} from './retrieval/memoryRanking'
export { MemoryVerifier } from './lifecycle/MemoryVerifier'
export type {
  MemorySourceStat,
  MemorySourceStatFn,
  MemoryVerifyOutcome,
  MemoryVerifierDeps
} from './lifecycle/MemoryVerifier'
export type {
  ScopeKind,
  MemoryKind,
  MemoryStatus,
  Explicitness,
  MemoryEvidenceType,
  MemoryScope,
  MemoryRecord,
  MemoryEvidence,
  MemoryRecordStatsRow,
  ScopeHint,
  MemoryCandidateIntent,
  MemoryCandidateEvidence,
  MemoryCandidate,
  MemoryPolicyRelatedRecord,
  MemoryPolicyContext,
  MemoryPolicyOperation,
  MemoryPolicyReason,
  MemoryPolicyRecordDraft,
  MemoryPolicyDecision
} from './types'
