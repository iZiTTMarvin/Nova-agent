/**
 * 记忆提炼与候选处理的集中默认配置。
 * 这些数值是行为契约的一部分：调整会改变既有库中 pending 晋升与等价合并的判定，
 * 必须连同 policy 测试一起评估。
 */

/** 每 N 个完成用户回合触发一次提炼 */
export const MEMORY_EXTRACT_INTERVAL_TURNS = 5

/** 提炼输入滑动窗口（最近 N 条会话消息） */
export const MEMORY_EXTRACT_WINDOW_SIZE = 50

/** 单条 evidence 摘录硬上限（先过 PrivacyFilter 再截断） */
export const MEMORY_EVIDENCE_EXCERPT_MAX_CHARS = 240

/** 候选 content 长度上限 */
export const MEMORY_CANDIDATE_CONTENT_MAX_CHARS = 400

/** memory_key 归一化后长度上限 */
export const MEMORY_KEY_MAX_CHARS = 64

/** 内容规范化相似度等价判定阈值（keyless 等价与同 key 内容比对共用） */
export const MEMORY_CONTENT_EQUIVALENCE_THRESHOLD = 0.6

/** MERGE 时置信度温和上调的步长与上限（只升不降） */
export const MEMORY_CONFIDENCE_STEP = 0.05
export const MEMORY_CONFIDENCE_CAP = 0.95

/** observed/inferred 晋升门槛：project 需跨 N 个 session，global 需跨 N 个 project */
export const MEMORY_PROMOTION_PROJECT_MIN_SESSIONS = 2
export const MEMORY_PROMOTION_GLOBAL_MIN_PROJECTS = 2

/** inferred 候选的置信度下限，低于此值直接忽略 */
export const MEMORY_INFERRED_MIN_CONFIDENCE = 0.4

/** keyless 候选等价族召回条数上限（scope+kind 内按 updated_at 倒序取最近记录） */
export const MEMORY_KEYLESS_RECALL_LIMIT = 50
