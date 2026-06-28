/**
 * webSearch 共享类型 — 兼容层 re-export
 * 业务逻辑在 runtime/tools/webSearch/types.ts 单点维护
 *
 * ⚠️ 维护约束：本文件仅做 re-export，禁止在此引入 Node 依赖或 runtime 具体实现。
 *    若 runtime 侧 types 引入 Node API，renderer 打包可能失败。
 */
export type {
  SearchProviderName,
  SearchSource,
  SearchQueryParams,
  SearchProviderError,
  SearchResponse,
  SearchProvider
} from '../../runtime/tools/webSearch/types'
