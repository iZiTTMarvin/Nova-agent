/**
 * 模型配置持久化与校验模块
 * 
 * 职责：
 * 1. 将 ModelConfig 持久化到本地文件系统（settings/model.json）
 * 2. 从本地文件系统加载 ModelConfig
 * 3. 对 ModelConfig 的字段进行格式校验，返回结构化的错误信息
 * 
 * 设计意图：
 * - 纯 TypeScript 模块，不依赖 Electron API，支持脱离 Electron 单测
 * - Electron 主进程通过此模块完成配置的读写和校验
 * - 全局只维护一份配置文件，不按项目或会话隔离
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ModelConfig } from '../../shared/config'

/** 配置文件相对路径（相对于 AppData 根目录） */
const CONFIG_RELATIVE_PATH = path.join('settings', 'model.json')

/** 校验错误：字段名 → 错误信息 */
export interface ConfigValidationError {
  field: 'baseUrl' | 'apiKey' | 'modelId'
  message: string
}

/** 校验结果：成功时返回 config，失败时返回错误列表 */
export type ConfigValidationResult =
  | { valid: true; config: ModelConfig }
  | { valid: false; errors: ConfigValidationError[] }

/**
 * 校验模型配置的各个字段
 * 
 * 校验规则：
 * - baseUrl: 必须是非空字符串，且以 http:// 或 https:// 开头
 * - apiKey: 必须是非空字符串（trim 后非空）
 * - modelId: 必须是非空字符串（trim 后非空）
 */
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

  // baseUrl 校验
  const baseUrl = (config.baseUrl ?? '').trim()
  if (!baseUrl) {
    errors.push({ field: 'baseUrl', message: '接口地址 (Base URL) 不能为空' })
  } else if (!/^https?:\/\/.+/.test(baseUrl)) {
    errors.push({ field: 'baseUrl', message: '接口地址必须以 http:// 或 https:// 开头，例如 https://api.openai.com/v1' })
  }

  // apiKey 校验
  const apiKey = (config.apiKey ?? '').trim()
  if (!apiKey) {
    errors.push({ field: 'apiKey', message: 'API Key 不能为空' })
  }

  // modelId 校验
  const modelId = (config.modelId ?? '').trim()
  if (!modelId) {
    errors.push({ field: 'modelId', message: '模型标识 (Model ID) 不能为空' })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    config: { baseUrl, apiKey, modelId }
  }
}

/**
 * 将模型配置持久化到磁盘
 * 
 * 写入前进行校验，确保只有合法配置才会落盘。
 * 校验失败时抛出包含字段错误信息的异常，调用方可据此向用户展示精确提示。
 * 校验成功时返回 trim 后的合法配置。
 */
export function saveModelConfig(config: ModelConfig, appDataPath: string): ModelConfig {
  const validation = validateModelConfig(config)
  if (!validation.valid) {
    const messages = validation.errors.map(e => e.message).join('；')
    throw new Error(`配置校验失败：${messages}`)
  }

  const configDir = path.join(appDataPath, 'settings')
  const configPath = path.join(appDataPath, CONFIG_RELATIVE_PATH)

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // 写入的是 trim 后的合法值
  fs.writeFileSync(configPath, JSON.stringify(validation.config, null, 2), 'utf8')

  return validation.config
}

/**
 * 从磁盘加载模型配置
 * 
 * 读取流程：
 * 1. 文件不存在 → 返回 null（首次使用正常场景）
 * 2. 文件存在但无法解析或校验不通过 → 返回 null（损坏配置静默忽略，不阻塞启动）
 * 3. 所有字段校验通过 → 返回 trim 后的合法 ModelConfig
 * 
 * 复用 validateModelConfig 做统一强校验，保证写入和读取的契约一致
 */
export function loadModelConfig(appDataPath: string): ModelConfig | null {
  const configPath = path.join(appDataPath, CONFIG_RELATIVE_PATH)

  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(content)

    // 复用统一校验：任何一个关键字段缺失或格式不对，都不允许进入启动链路
    const validation = validateModelConfig(parsed)
    if (!validation.valid) {
      return null
    }

    return validation.config
  } catch {
    return null
  }
}

/**
 * 获取配置文件的绝对路径（供外部模块引用）
 */
export function getModelConfigPath(appDataPath: string): string {
  return path.join(appDataPath, CONFIG_RELATIVE_PATH)
}
