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
  WORKSPACE_HASH_LENGTH
} from './MemoryPaths'
export { MemoryService, DEFAULT_L1_MAX_CHARS } from './MemoryService'
export type { MemoryServiceOptions } from './MemoryService'
export {
  applyL1Budget,
  applyL2Budget,
  DEFAULT_L2_MAX_CHARS,
  DEFAULT_L2_SNIPPET_MAX_CHARS,
  L2_HIT_SEPARATOR
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
  consolidateExtracted,
  consolidateFallback,
  shouldAutoMergeExtracted,
  EPISODIC_SUMMARY_REL_PATH
} from './MemoryConsolidator'
export type { ConsolidateExtractedResult, ConsolidateExtractedOptions } from './MemoryConsolidator'
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
export { MemoryExtractor, parseExtractedJson, EXTRACT_REASONING_EFFORT } from './MemoryExtractor'
export type { ExtractedMemory, MemoryExtractorDeps } from './MemoryExtractor'
export { EXTRACT_WINDOW_SIZE, buildExtractMessages } from './memoryPrompts'
