/**
 * memory_search 工具类型
 */

/** 工具入参 */
export interface MemorySearchArgs {
  query: string
  /** true 时允许返回 superseded / retracted / needs_verification 并带标注 */
  history?: boolean
}
