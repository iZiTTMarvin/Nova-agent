/** 大纲生成与取证容量护栏；调用处只引用这里的常量。 */
export const LEARNING_SKELETON_MAX_INITIAL_NODES = 24
export const LEARNING_MAX_COMPILE_OUTPUT_BYTES = 256 * 1024
export const LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS = 1
export const LEARNING_DISCOVERY_MAX_ENTRIES = 4096

/** 骨架请求输入的上限；实际预算取 min(上限, 模型窗口 − 输出预留)。 */
export const LEARNING_SKELETON_INPUT_TOKEN_CAP = 16_000
export const LEARNING_COMPILE_OUTPUT_RESERVE_TOKENS = 12_000
/** 预算低于此值时不调用模型，直接报「上下文太小」。 */
export const LEARNING_SKELETON_MIN_INPUT_TOKENS = 6_000

/** 读取单个文件（取片段、核对出处）的字节上限；片段可以落在这个范围内的任意位置。 */
export const LEARNING_EVIDENCE_PER_FILE_MAX_BYTES = 256 * 1024
/** 统计引用关系时每个文件只扫描开头这么多字节。 */
export const LEARNING_IMPORT_SCAN_BYTES = 8 * 1024
/** 按优先级准备的候选片段数；最终装入多少由预算决定。 */
export const LEARNING_SKELETON_MAX_CANDIDATE_FRAGMENTS = 64
export const LEARNING_FRAGMENT_MAX_LINES = 80
export const LEARNING_FRAGMENT_MAX_BYTES = 4 * 1024
export const LEARNING_PACKAGE_JSON_MAX_LINES = 120
/** 目录概览最多列出的目录数（两层）。 */
export const LEARNING_PROJECT_LAYOUT_MAX_ENTRIES = 40
