/**
 * 最终 API 请求体的匿名结构指纹（约束 5）。
 *
 * 只纳入角色序列、工具名序、内容长度、字段存在性等结构化信息；
 * 不含 headers、apiKey、明文 prompt、thinking 正文或工具输出。
 * 供缓存诊断与会话级观测对比「本应稳定」的前缀是否漂移。
 */
import { createHash } from 'crypto'

/**
 * 对已构建完成的最终请求 body 生成不可逆短哈希。
 * @param body 即将发给 provider 的 JSON 对象（已含 messages/tools 等）
 */
export function fingerprintFinalRequestBody(body: Record<string, unknown>): string {
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []

  const structural = {
    model: typeof body.model === 'string' ? body.model : '',
    messageRoles: messages.map(m => String(m.role ?? '')),
    messageContentLens: messages.map(m => {
      const c = m.content
      if (typeof c === 'string') return c.length
      if (Array.isArray(c)) return JSON.stringify(c).length
      return 0
    }),
    hasToolCalls: messages.map(m => Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
    toolNames: tools.map(t => {
      const fn = t.function as { name?: string } | undefined
      return fn?.name ?? ''
    }),
    hasPromptCacheKey: 'prompt_cache_key' in body,
    hasCacheControlSomewhere: JSON.stringify(body).includes('"cache_control"')
  }

  return createHash('sha256').update(JSON.stringify(structural)).digest('hex').slice(0, 16)
}
