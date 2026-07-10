/**
 * v1 ModelConfig 字段校验（供迁移与兼容 IPC 使用）
 */
import type { ModelConfig } from '../../shared/config'

/** 校验错误：字段名 → 错误信息 */
export interface ConfigValidationError {
  field: 'baseUrl' | 'apiKey' | 'modelId' | 'toolDialect'
  message: string
}

/** 校验结果 */
export type ConfigValidationResult =
  | { valid: true; config: ModelConfig }
  | { valid: false; errors: ConfigValidationError[] }

const VALID_TOOL_DIALECTS = new Set(['auto', 'native', 'xml'])

export function validateModelConfig(config: Partial<ModelConfig> | null | undefined): ConfigValidationResult {
  const errors: ConfigValidationError[] = []

  if (!config) {
    return {
      valid: false,
      errors: [
        { field: 'baseUrl', message: '接口地址 (Base URL) 不能为空' },
        { field: 'apiKey', message: 'API Key 不能为空' },
        { field: 'modelId', message: '模型标识 (Model ID) 不能为空' }
      ]
    }
  }

  const baseUrl = (config.baseUrl ?? '').trim()
  if (!baseUrl) {
    errors.push({ field: 'baseUrl', message: '接口地址 (Base URL) 不能为空' })
  } else if (!/^https?:\/\/.+/.test(baseUrl)) {
    errors.push({
      field: 'baseUrl',
      message: '接口地址必须以 http:// 或 https:// 开头，例如 https://api.openai.com/v1'
    })
  }

  const apiKey = (config.apiKey ?? '').trim()
  if (!apiKey) {
    errors.push({ field: 'apiKey', message: 'API Key 不能为空' })
  }

  const modelId = (config.modelId ?? '').trim()
  if (!modelId) {
    errors.push({ field: 'modelId', message: '模型标识 (Model ID) 不能为空' })
  }

  if (
    config.toolDialect !== undefined &&
    config.toolDialect !== 'auto' &&
    !VALID_TOOL_DIALECTS.has(config.toolDialect)
  ) {
    errors.push({
      field: 'toolDialect',
      message: "工具调用方式必须是 'auto'、'native' 或 'xml'"
    })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const toolDialect = normalizeToolDialect(config.toolDialect)

  return {
    valid: true,
    config: {
      baseUrl,
      apiKey,
      modelId,
      ...(config.cacheStrategy ? { cacheStrategy: config.cacheStrategy } : {}),
      ...(config.cacheProfile && config.cacheProfile !== 'auto'
        ? { cacheProfile: config.cacheProfile }
        : {}),
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      ...(config.supportsVision !== undefined ? { supportsVision: config.supportsVision } : {}),
      ...(config.fallbacks && config.fallbacks.length > 0 ? { fallbacks: config.fallbacks } : {}),
      ...(toolDialect ? { toolDialect } : {})
    }
  }
}

function normalizeToolDialect(
  value: ModelConfig['toolDialect'] | undefined
): ModelConfig['toolDialect'] | undefined {
  if (!value || value === 'auto') return undefined
  if (VALID_TOOL_DIALECTS.has(value)) return value
  return undefined
}
