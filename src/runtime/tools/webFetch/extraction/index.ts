import { createClairicProvider, hasClairicCredentials } from './clairic'
import { createCurrentModelProvider } from './modelClient'
import type { FieldExtractionContext, FieldExtractionProvider } from './types'

export { ExtractionResultCache } from './cache'
export {
  canonicalFieldSpecs,
  currentExtractionReferenceDate,
  extractPageFields,
  formatPageExtraction,
  parseExtractFields
} from './fields'
export type {
  ExtractionProviderName,
  FieldExtractionContext,
  FieldExtractionProvider,
  FieldResult,
  FieldSpec,
  PageExtraction,
  SourceEvidence
} from './types'

/** 只在调用前选择一次 provider；失败不会把页面改投到另一家服务。 */
export function resolveFieldExtractionProvider(
  context: FieldExtractionContext
): FieldExtractionProvider {
  const env = context.env ?? process.env
  const hasPartialCloudflareConfig = Boolean(env.CLOUDFLARE_API_KEY?.trim() || env.CLOUDFLARE_ACCOUNT_ID?.trim())
  if (hasPartialCloudflareConfig && !hasClairicCredentials(env)) {
    throw new Error('Clairic 需要同时配置 CLOUDFLARE_API_KEY 与 CLOUDFLARE_ACCOUNT_ID；不会自动改投当前模型')
  }
  if (hasClairicCredentials(env)) return createClairicProvider(env)
  if (context.modelClient) {
    return createCurrentModelProvider({
      ...context,
      modelClient: context.modelClient
    })
  }
  throw new Error('当前会话没有可用的提取模型；请使用默认正文模式，或配置 Cloudflare Workers AI')
}
