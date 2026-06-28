/**
 * webSearch 工具类型定义（runtime 侧单点维护）
 * shared/webSearch/types.ts 通过 re-export 兼容 renderer 引用
 */

/** 已知的搜索 provider 名称 */
export type SearchProviderName = 'bing' | 'duckduckgo' | 'tavily' | 'brave' | 'exa'

/** 单条搜索结果来源 */
export interface SearchSource {
  /** 结果标题 */
  title: string
  /** 结果 URL（可点击） */
  url: string
  /** 摘要片段（可无） */
  snippet?: string
  /** 发布时间（可无，不同 provider 精度不同） */
  publishedDate?: string
}

/** 搜索请求参数 */
export interface SearchQueryParams {
  /** 搜索关键词或问句 */
  query: string
  /** 最大返回结果数（默认 5，上限受 provider 限制） */
  maxResults?: number
  /**
   * 时间范围过滤。
   * day = 24小时内，week = 一周内，month = 一个月内，year = 一年内。
   */
  recency?: 'day' | 'week' | 'month' | 'year'
}

/** 单个 provider 返回的错误信息 */
export interface SearchProviderError {
  /** 哪个 provider 失败了 */
  provider: SearchProviderName
  /** 人类可读的错误描述 */
  message: string
  /** HTTP 状态码（如有） */
  statusCode?: number
}

/** 搜索工具的统一返回结构 */
export interface SearchResponse {
  /** 本次使用的 provider 名称 */
  provider: SearchProviderName
  /** AI 整理的摘要回答（如 provider 支持，无则 undefined） */
  answer?: string
  /** 搜索结果列表 */
  sources: SearchSource[]
  /** 本次请求 ID（用于日志追踪） */
  requestId?: string
}

/**
 * 单个搜索 provider 的适配器接口。
 * 每个 provider 实现此接口，由链管理器按 fallback 顺序调度。
 */
export interface SearchProvider {
  /** provider 标识符 */
  name: SearchProviderName
  /** 检查此 provider 当前是否可用（如 API key 是否配置、是否在冷却期） */
  isAvailable(): boolean
  /**
   * 执行搜索请求。
   * 失败应抛出 SearchProviderError（由工具层捕获）。
   */
  search(params: SearchQueryParams, signal: AbortSignal): Promise<SearchResponse>
}
