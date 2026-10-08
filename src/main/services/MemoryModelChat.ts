import { app } from 'electron'
import { loadModelConfig } from '../../runtime/model/config'
import type { MemoryExtractorDeps } from '../../runtime/memory/extraction/MemoryExtractor'
import { MEMORY_EXTRACT_MAX_OUTPUT_TOKENS, MEMORY_EXTRACT_TIMEOUT_MS } from '../../runtime/memory/memoryConfig'
import { createModelClient } from './createModelClient'

/** Uses an isolated client for each bounded memory-model request. */
export function createExtractChatFn(): MemoryExtractorDeps['chat'] {
  return async (messages, opts) => {
    const config = loadModelConfig(app.getPath('userData'))
    if (!config?.apiKey?.trim()) throw new Error('Extraction model configuration unavailable')
    const client = createModelClient({ ...config, reasoningEffort: opts?.reasoningEffort ?? 'low' })
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    opts?.abortSignal?.addEventListener('abort', abort, { once: true })
    if (opts?.abortSignal?.aborted) controller.abort()
    const timeout = setTimeout(abort, MEMORY_EXTRACT_TIMEOUT_MS)
    try {
      let text = ''
      for await (const event of client.chat(messages, undefined, { abortSignal: controller.signal, maxOutputTokens: MEMORY_EXTRACT_MAX_OUTPUT_TOKENS })) {
        if (event.type === 'error' || event.type === 'cancelled' || event.type === 'context_overflow') throw new Error('Extraction model request failed')
        if (event.type === 'text_delta') text += event.delta
      }
      if (controller.signal.aborted) throw new Error('Extraction model request cancelled')
      return text
    } finally { clearTimeout(timeout); opts?.abortSignal?.removeEventListener('abort', abort) }
  }
}
