/**
 * 从服务商 API 拉取可用模型列表（OpenAI 兼容 /models 端点）
 */
export interface FetchModelsParams {
  baseUrl: string
  apiKey: string
}

export interface FetchModelsResult {
  ok: true
  modelIds: string[]
}

export interface FetchModelsError {
  ok: false
  message: string
}

export type FetchModelsResponse = FetchModelsResult | FetchModelsError

/**
 * 调用 OpenAI 兼容 GET {baseUrl}/models 拉取模型 ID 列表。
 * baseUrl 通常以 /v1 结尾，会自动拼接 /models。
 */
export async function fetchProviderModels(params: FetchModelsParams): Promise<FetchModelsResponse> {
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = params.apiKey.trim()

  if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) {
    return { ok: false, message: '接口地址无效' }
  }
  if (!apiKey) {
    return { ok: false, message: '请先填写 API Key' }
  }

  const url = `${baseUrl}/models`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        message: `拉取失败 (${response.status})${text ? `: ${text.slice(0, 120)}` : ''}`
      }
    }

    const json = (await response.json()) as { data?: Array<{ id?: string }> }
    const modelIds = (json.data ?? [])
      .map(item => (typeof item.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean)

    if (modelIds.length === 0) {
      return { ok: false, message: '接口返回的模型列表为空' }
    }

    return { ok: true, modelIds }
  } catch (err) {
    const message = err instanceof Error ? err.message : '网络请求失败'
    return { ok: false, message }
  }
}
