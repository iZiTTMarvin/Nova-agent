/**
 * 模型配置持久化与校验模块
 *
 * 职责：
 * 1. 将 LlmRegistry (v2) 持久化到 settings/model.json
 * 2. 兼容 v1 ModelConfig 自动迁移
 * 3. loadModelConfig 返回当前活跃模型的 ModelConfig（供 Agent 运行时）
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ModelConfig } from '../../shared/config'
import {
  type LlmRegistry,
  migrateV1ToV2,
  validateLlmRegistry,
  resolveActiveModelConfig,
  resolveFallbackModelConfigs,
  isLlmRegistryV2
} from '../../shared/config/llmRegistry'
import { validateModelConfig } from './configLegacy'
import { atomicWriteFileSync } from '../storage/atomicFile'

/** 配置文件相对路径（相对于 AppData 根目录） */
const CONFIG_RELATIVE_PATH = path.join('settings', 'model.json')

/** 校验错误：字段名 → 错误信息 */
export interface ConfigValidationError {
  field: 'baseUrl' | 'apiKey' | 'modelId' | 'toolDialect'
  message: string
}

/** 校验结果：成功时返回 config，失败时返回错误列表 */
export type ConfigValidationResult =
  | { valid: true; config: ModelConfig }
  | { valid: false; errors: ConfigValidationError[] }

// 重导出 v1 校验（测试与兼容）
export { validateModelConfig } from './configLegacy'

/**
 * 从磁盘读取原始 JSON（v1 或 v2）
 */
function readRawConfigFile(appDataPath: string): unknown | null {
  const configPath = path.join(appDataPath, CONFIG_RELATIVE_PATH)
  if (!fs.existsSync(configPath)) return null
  try {
    const content = fs.readFileSync(configPath, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * 解析磁盘配置为 LlmRegistry（含 v1 自动迁移）
 */
export function parseLlmRegistryFromDisk(raw: unknown): LlmRegistry | null {
  if (!raw || typeof raw !== 'object') return null

  if (isLlmRegistryV2(raw)) {
    const validation = validateLlmRegistry(raw)
    return validation.valid ? validation.registry : null
  }

  // v1：单 ModelConfig
  const v1Result = validateModelConfig(raw as Partial<ModelConfig>)
  if (!v1Result.valid) return null
  return migrateV1ToV2(v1Result.config)
}

/**
 * 加载 LLM 注册表
 */
export function loadLlmRegistry(appDataPath: string): LlmRegistry | null {
  const raw = readRawConfigFile(appDataPath)
  if (!raw) return null
  return parseLlmRegistryFromDisk(raw)
}

/**
 * 保存 LLM 注册表到磁盘
 */
export function saveLlmRegistry(appDataPath: string, registry: LlmRegistry): LlmRegistry {
  const validation = validateLlmRegistry(registry)
  if (!validation.valid) {
    throw new Error(`配置校验失败：${validation.message}`)
  }

  const configDir = path.join(appDataPath, 'settings')
  const configPath = path.join(appDataPath, CONFIG_RELATIVE_PATH)

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  atomicWriteFileSync(configPath, JSON.stringify(validation.registry, null, 2), 'utf8')
  return validation.registry
}

/**
 * 从磁盘加载当前活跃模型配置（Agent 运行时使用）
 */
export function loadModelConfig(appDataPath: string): ModelConfig | null {
  const registry = loadLlmRegistry(appDataPath)
  if (!registry) return null

  const active = resolveActiveModelConfig(registry)
  if (!active) return null

  // 附加 fallbacks 供 ModelClientPool 使用
  const fallbacks = resolveFallbackModelConfigs(registry)
  if (fallbacks.length > 0) {
    return { ...active, fallbacks }
  }
  return active
}

/**
 * 保存 v1 ModelConfig（兼容旧 IPC；内部转为 v2 注册表）
 */
export function saveModelConfig(config: ModelConfig, appDataPath: string): ModelConfig {
  const validation = validateModelConfig(config)
  if (!validation.valid) {
    const messages = validation.errors.map(e => e.message).join('；')
    throw new Error(`配置校验失败：${messages}`)
  }

  const registry = migrateV1ToV2(validation.config)
  saveLlmRegistry(appDataPath, registry)
  return validation.config
}

/**
 * 仅切换活跃模型（不写全盘 providers）
 */
export function setActiveModelInRegistry(
  appDataPath: string,
  ref: { providerId: string; modelEntryId: string }
): LlmRegistry {
  const registry = loadLlmRegistry(appDataPath)
  if (!registry) {
    throw new Error('尚未配置任何服务商')
  }

  const provider = registry.providers.find(p => p.id === ref.providerId)
  const entry = provider?.models.find(m => m.id === ref.modelEntryId)
  if (!provider || !entry) {
    throw new Error('所选模型不存在')
  }

  const next: LlmRegistry = {
    ...registry,
    activeModel: { providerId: ref.providerId, modelEntryId: ref.modelEntryId }
  }

  return saveLlmRegistry(appDataPath, next)
}

/**
 * 获取配置文件的绝对路径
 */
export function getModelConfigPath(appDataPath: string): string {
  return path.join(appDataPath, CONFIG_RELATIVE_PATH)
}
