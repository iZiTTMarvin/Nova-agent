import type {
  ExtractionProviderResponse,
  FieldExtractionProvider,
  ExtractionRequest
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

export function hasClairicCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLOUDFLARE_API_KEY?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim())
}

/** Cloudflare 专用提取模型适配器；凭据只用于当前请求，不进入日志、缓存键或结果。 */
export function createClairicProvider(
  env: Record<string, string | undefined>
): FieldExtractionProvider {
  const apiKey = env.CLOUDFLARE_API_KEY?.trim() ?? ''
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ''
  const gatewayId = env.CLOUDFLARE_GATEWAY_ID?.trim()
  if (!apiKey || !accountId) throw new Error('Clairic 凭据不完整')

  return {
    name: 'clairic',
    cacheKey: 'clairic:@cf/cloudflare/clairic',
    async extract(request: ExtractionRequest): Promise<ExtractionProviderResponse> {
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/clairic`
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(gatewayId ? { 'cf-aig-gateway-id': gatewayId } : {})
          },
          body: JSON.stringify({
            model: 'clairic',
            state: request.page,
            fields: request.fields,
            reference_date: request.referenceDate
          }),
          signal: request.signal
        })
        const text = await response.text()
        if (!response.ok) {
          const detail = redactSecret(text, apiKey).trim().slice(0, 200)
          throw new Error(`Cloudflare Workers AI 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error('Cloudflare Workers AI 返回了非 JSON 响应')
        }
        if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.result)) {
          throw new Error('Cloudflare Workers AI 返回了失败或结构不完整的响应')
        }
        if (!isRecord(parsed.result.answers)) throw new Error('Clairic 响应缺少 answers')
        return {
          answers: parsed.result.answers,
          truncated: parsed.result.truncated === true
        }
      } catch (error) {
        throw new Error(redactSecret(error instanceof Error ? error.message : String(error), apiKey))
      }
    }
  }
}
