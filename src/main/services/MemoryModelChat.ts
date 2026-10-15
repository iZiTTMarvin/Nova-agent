import { app } from 'electron'
import { loadLlmRegistry } from '../../runtime/model/config'
import { ModelClientPool } from '../../runtime/model/ModelClientPool'
import { resolveBackgroundModelConfig } from '../../shared/config/llmRegistry'
import type { MemoryExtractorDeps } from '../../runtime/memory/extraction/MemoryExtractor'
import { MEMORY_EXTRACT_MAX_OUTPUT_TOKENS } from '../../runtime/memory/memoryConfig'
import { createModelClient } from './createModelClient'

/** 每次后台记忆请求独立建 client；超时由 pool 按服务商档案与思考强度计算。 */
export function createExtractChatFn(): MemoryExtractorDeps['chat'] {
  return async (messages, opts) => {
    const registry = loadLlmRegistry(app.getPath('userData'))
    const config = registry ? resolveBackgroundModelConfig(registry) : null
    if (!config) throw new Error('Extraction model configuration unavailable')
    const client = new ModelClientPool({ primary: createModelClient(config), primaryConfig: config })
    let text = ''
    for await (const event of client.chat(messages, undefined, { abortSignal: opts?.abortSignal, maxOutputTokens: MEMORY_EXTRACT_MAX_OUTPUT_TOKENS })) {
      if (event.type === 'error' || event.type === 'cancelled' || event.type === 'context_overflow') throw new Error('Extraction model request failed')
      if (event.type === 'text_delta') text += event.delta
    }
    if (opts?.abortSignal?.aborted) throw new Error('Extraction model request cancelled')
    return text
  }
}
