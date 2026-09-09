/**
 * 主进程模型客户端的唯一构造入口：统一注入 Chromium 传输，
 * 保证主对话、fallback、子代理与记忆提炼走同一条出网路径。
 */
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import type { ModelClientConfig } from '../../runtime/model/types'
import { electronTransportFetch } from '../network/electronTransportFetch'

export function createModelClient(config: ModelClientConfig): OpenAICompatibleModelClient {
  return new OpenAICompatibleModelClient(config, { fetchImpl: electronTransportFetch })
}
