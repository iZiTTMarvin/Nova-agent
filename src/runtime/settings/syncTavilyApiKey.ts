/**
 * 将 ~/.nova/settings.json 中的 Tavily API Key 同步到进程环境变量
 * 供 webSearch provider 的 isAvailable() / search() 读取
 */
import { loadNovaSettings } from './novaSettings'

export function syncTavilyApiKeyFromSettings(): void {
  const key = loadNovaSettings().webSearchTavilyApiKey
  if (key) {
    process.env.TAVILY_API_KEY = key
  } else {
    delete process.env.TAVILY_API_KEY
  }
}
