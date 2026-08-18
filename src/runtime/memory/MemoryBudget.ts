/**
 * 记忆预算常量：检索/prefetch 注入的条数与字符上限集中于此，禁止散落魔法数字。
 * 这些数值是行为契约的一部分：调整会改变注入块形状与检索截断，须连同相关测试评估。
 */

// ---------------------------------------------------------------------------
// prefetch 动态注入预算（PRD 18.2）
// ---------------------------------------------------------------------------

/** 动态记忆注入块总字符上限 */
export const MEMORY_PREFETCH_TOTAL_MAX_CHARS = 2400

/** 单条 structured 记忆注入字符上限 */
export const MEMORY_PREFETCH_STRUCTURED_MAX_CHARS = 320

/** project structured 记忆注入条数上限 */
export const MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS = 4

/** global 记忆注入条数上限 */
export const MEMORY_PREFETCH_GLOBAL_MAX_ITEMS = 2

/** 手写文档 / episodic 命中注入条数上限 */
export const MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS = 2

/** prefetch 候选拉取条数（组合层送入排序的池大小） */
export const MEMORY_PREFETCH_CANDIDATE_LIMIT = 12

/** prefetch 相关性下限（相对池内 top 的比例；低于此比例的尾部队不注入） */
export const MEMORY_PREFETCH_SCORE_FLOOR = 0.25

/** 文档命中片段的默认字符上限（extractMemorySnippet） */
export const MEMORY_SNIPPET_MAX_CHARS = 400
