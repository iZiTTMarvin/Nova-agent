/**
 * Nova 全局设置持久化（~/.nova/settings.json）
 *
 * Task 5/13：第三方 skill 开关等应用级配置
 * PRD §5.6：扩展为完整用户偏好 schema，含默认模式、bash shell、字体、主题等。
 *
 * 设计要点：
 * - NovaSettings 与 NovaSettingsDto 结构对齐（dto 即 schema）。
 * - 加载时做默认值填充：旧版本单字段 settings.json 会安全升级到完整 schema。
 * - 保存时做 schema 校验：非法值拒绝（如负数字号、未知 theme）。
 * - 迁移函数独立，失败不阻塞启动（回退默认值）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Mode, PermissionPolicy } from '../../shared/session/types'
import type { NovaSettingsDto } from '../../shared/settings/types'

/** 应用级设置字段（与 NovaSettingsDto 完全对齐） */
export type NovaSettings = NovaSettingsDto

/** 当前 settings schema 版本（用于未来迁移） */
const CURRENT_SETTINGS_VERSION = 1

/** 默认值：所有字段的兜底 */
export const DEFAULT_NOVA_SETTINGS: NovaSettings = {
  loadThirdPartySkills: true,
  defaultMode: 'default',
  permissionPolicy: 'ask',
  defaultShell: '',
  defaultShellTimeout: 120_000,
  maxToolRounds: 100,
  editorFontSize: 13,
  editorFontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
  theme: 'system',
  diffAutoExpand: false,
  lastProjectPath: null,
  snapshotRetentionDays: 30,
  webSearchTavilyApiKey: undefined,
  memoryEnabled: false,
  memorySearchLimit: 10,
  memoryScoreFloor: 0.15,
  memoryReconcileOnSearch: false,
  // 用户视角下记忆只有「总开关」一个按钮（memoryEnabled）。
  // 下列三个子开关默认 true：开启记忆即一并启用采集 / 提炼 / episodic 落盘，
  // 不再要求用户逐个勾选。UI 不暴露这三个开关。
  memoryCaptureEnabled: true,
  memoryEpisodicSummaryEnabled: true,
  memoryExtractEnabled: true,
  // 自动合并到 MEMORY.md 会改写用户手写的权威语义记忆，
  // 测试版阶段默认关；UI 仍保留这一个开关供用户主动开启。
  memoryAutoMergeEnabled: false
}

/** 返回 ~/.nova 目录路径 */
export function getNovaHomeDir(): string {
  return join(homedir(), '.nova')
}

function getSettingsPath(): string {
  return join(getNovaHomeDir(), 'settings.json')
}

/**
 * 把任意未知结构的磁盘数据迁移 + 默认值填充为完整 NovaSettings。
 *
 * 迁移逻辑：
 * - 无 settingsVersion 视为 v0（旧版只有 loadThirdPartySkills 单字段）。
 * - v0 → v1：补全所有新增字段为默认值。
 * - 逐字段用默认值兜底（即便 v1 也可能有字段缺失，防御性填充）。
 */
function migrateAndFill(raw: unknown): NovaSettings {
  const obj = (raw ?? {}) as Record<string, unknown>
  const result: NovaSettings = { ...DEFAULT_NOVA_SETTINGS }

  // 逐字段安全填充：只在类型合法时采用磁盘值，否则用默认值
  if (typeof obj.loadThirdPartySkills === 'boolean') {
    result.loadThirdPartySkills = obj.loadThirdPartySkills
  }
  // 旧 Mode 含 auto：迁为 default，并尽量把 permissionPolicy 写成 auto
  let migratedAutoMode = false
  if (obj.defaultMode === 'auto') {
    result.defaultMode = 'default'
    migratedAutoMode = true
  } else if (obj.defaultMode === 'plan' || obj.defaultMode === 'default' || obj.defaultMode === 'compose') {
    result.defaultMode = obj.defaultMode as Mode
  }
  if (obj.permissionPolicy === 'ask' || obj.permissionPolicy === 'auto') {
    result.permissionPolicy = obj.permissionPolicy as PermissionPolicy
  } else if (migratedAutoMode) {
    result.permissionPolicy = 'auto'
  }
  if (typeof obj.defaultShell === 'string') {
    result.defaultShell = obj.defaultShell
  }
  if (typeof obj.defaultShellTimeout === 'number' && obj.defaultShellTimeout >= 0) {
    result.defaultShellTimeout = obj.defaultShellTimeout
  }
  if (
    typeof obj.maxToolRounds === 'number' &&
    Number.isInteger(obj.maxToolRounds) &&
    obj.maxToolRounds >= 1 &&
    obj.maxToolRounds <= 1000
  ) {
    result.maxToolRounds = obj.maxToolRounds
  }
  if (typeof obj.editorFontSize === 'number' && Number.isInteger(obj.editorFontSize) && obj.editorFontSize >= 8 && obj.editorFontSize <= 32) {
    result.editorFontSize = obj.editorFontSize
  }
  if (typeof obj.editorFontFamily === 'string' && obj.editorFontFamily.trim()) {
    result.editorFontFamily = obj.editorFontFamily
  }
  if (obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system') {
    result.theme = obj.theme
  }
  if (typeof obj.diffAutoExpand === 'boolean') {
    result.diffAutoExpand = obj.diffAutoExpand
  }
  if (typeof obj.lastProjectPath === 'string') {
    result.lastProjectPath = obj.lastProjectPath
  }
  if (
    typeof obj.snapshotRetentionDays === 'number' &&
    Number.isInteger(obj.snapshotRetentionDays) &&
    obj.snapshotRetentionDays >= 0 &&
    obj.snapshotRetentionDays <= 365
  ) {
    result.snapshotRetentionDays = obj.snapshotRetentionDays
  }
  if (typeof obj.webSearchTavilyApiKey === 'string') {
    result.webSearchTavilyApiKey = obj.webSearchTavilyApiKey
  }
  if (typeof obj.memoryEnabled === 'boolean') {
    result.memoryEnabled = obj.memoryEnabled
  }
  if (
    typeof obj.memorySearchLimit === 'number' &&
    Number.isInteger(obj.memorySearchLimit) &&
    obj.memorySearchLimit >= 1
  ) {
    result.memorySearchLimit = obj.memorySearchLimit
  }
  if (
    typeof obj.memoryScoreFloor === 'number' &&
    obj.memoryScoreFloor >= 0 &&
    obj.memoryScoreFloor <= 1
  ) {
    result.memoryScoreFloor = obj.memoryScoreFloor
  }
  if (typeof obj.memoryReconcileOnSearch === 'boolean') {
    result.memoryReconcileOnSearch = obj.memoryReconcileOnSearch
  }
  if (typeof obj.memoryCaptureEnabled === 'boolean') {
    result.memoryCaptureEnabled = obj.memoryCaptureEnabled
  }
  if (typeof obj.memoryEpisodicSummaryEnabled === 'boolean') {
    result.memoryEpisodicSummaryEnabled = obj.memoryEpisodicSummaryEnabled
  }
  if (typeof obj.memoryAutoMergeEnabled === 'boolean') {
    result.memoryAutoMergeEnabled = obj.memoryAutoMergeEnabled
  }
  if (typeof obj.memoryExtractEnabled === 'boolean') {
    result.memoryExtractEnabled = obj.memoryExtractEnabled
  }

  return result
}

/**
 * 校验 patch 的字段合法性。返回错误消息列表（空表示全部合法）。
 * 用于 saveNovaSettings 拒绝非法值。
 */
function validatePatch(patch: Partial<NovaSettings>): string[] {
  const errors: string[] = []
  if ('defaultMode' in patch && patch.defaultMode !== undefined) {
    if (!['plan', 'default', 'compose'].includes(patch.defaultMode)) {
      errors.push('defaultMode 必须是 plan / default / compose 之一')
    }
  }
  if ('permissionPolicy' in patch && patch.permissionPolicy !== undefined) {
    if (!['ask', 'auto'].includes(patch.permissionPolicy)) {
      errors.push('permissionPolicy 必须是 ask / auto 之一')
    }
  }
  if ('defaultShellTimeout' in patch && patch.defaultShellTimeout !== undefined) {
    if (typeof patch.defaultShellTimeout !== 'number' || patch.defaultShellTimeout < 0) {
      errors.push('defaultShellTimeout 必须是非负数')
    }
  }
  if ('maxToolRounds' in patch && patch.maxToolRounds !== undefined) {
    if (
      typeof patch.maxToolRounds !== 'number' ||
      !Number.isInteger(patch.maxToolRounds) ||
      patch.maxToolRounds < 1 ||
      patch.maxToolRounds > 1000
    ) {
      errors.push('maxToolRounds 必须是 1~1000 之间的整数')
    }
  }
  if ('editorFontSize' in patch && patch.editorFontSize !== undefined) {
    if (typeof patch.editorFontSize !== 'number' || !Number.isInteger(patch.editorFontSize) || patch.editorFontSize < 8 || patch.editorFontSize > 32) {
      errors.push('editorFontSize 必须是 8~32 之间的整数')
    }
  }
  if ('theme' in patch && patch.theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(patch.theme)) {
      errors.push('theme 必须是 light / dark / system 之一')
    }
  }
  if ('defaultShell' in patch && patch.defaultShell !== undefined && typeof patch.defaultShell !== 'string') {
    errors.push('defaultShell 必须是字符串')
  }
  if ('editorFontFamily' in patch && patch.editorFontFamily !== undefined && typeof patch.editorFontFamily !== 'string') {
    errors.push('editorFontFamily 必须是字符串')
  }
  if ('snapshotRetentionDays' in patch && patch.snapshotRetentionDays !== undefined) {
    if (
      typeof patch.snapshotRetentionDays !== 'number' ||
      !Number.isInteger(patch.snapshotRetentionDays) ||
      patch.snapshotRetentionDays < 0 ||
      patch.snapshotRetentionDays > 365
    ) {
      errors.push('snapshotRetentionDays 必须是 0~365 之间的整数（0 表示关闭自动 GC）')
    }
  }
  if ('webSearchTavilyApiKey' in patch && patch.webSearchTavilyApiKey !== undefined) {
    if (typeof patch.webSearchTavilyApiKey !== 'string') {
      errors.push('webSearchTavilyApiKey 必须是字符串')
    }
  }
  if ('memoryEnabled' in patch && patch.memoryEnabled !== undefined) {
    if (typeof patch.memoryEnabled !== 'boolean') {
      errors.push('memoryEnabled 必须是布尔值')
    }
  }
  if ('memorySearchLimit' in patch && patch.memorySearchLimit !== undefined) {
    if (
      typeof patch.memorySearchLimit !== 'number' ||
      !Number.isInteger(patch.memorySearchLimit) ||
      patch.memorySearchLimit < 1
    ) {
      errors.push('memorySearchLimit 必须是正整数')
    }
  }
  if ('memoryScoreFloor' in patch && patch.memoryScoreFloor !== undefined) {
    if (
      typeof patch.memoryScoreFloor !== 'number' ||
      patch.memoryScoreFloor < 0 ||
      patch.memoryScoreFloor > 1
    ) {
      errors.push('memoryScoreFloor 必须是 0~1 之间的数')
    }
  }
  if ('memoryReconcileOnSearch' in patch && patch.memoryReconcileOnSearch !== undefined) {
    if (typeof patch.memoryReconcileOnSearch !== 'boolean') {
      errors.push('memoryReconcileOnSearch 必须是布尔值')
    }
  }
  if ('memoryCaptureEnabled' in patch && patch.memoryCaptureEnabled !== undefined) {
    if (typeof patch.memoryCaptureEnabled !== 'boolean') {
      errors.push('memoryCaptureEnabled 必须是布尔值')
    }
  }
  if ('memoryEpisodicSummaryEnabled' in patch && patch.memoryEpisodicSummaryEnabled !== undefined) {
    if (typeof patch.memoryEpisodicSummaryEnabled !== 'boolean') {
      errors.push('memoryEpisodicSummaryEnabled 必须是布尔值')
    }
  }
  if ('memoryAutoMergeEnabled' in patch && patch.memoryAutoMergeEnabled !== undefined) {
    if (typeof patch.memoryAutoMergeEnabled !== 'boolean') {
      errors.push('memoryAutoMergeEnabled 必须是布尔值')
    }
  }
  if ('memoryExtractEnabled' in patch && patch.memoryExtractEnabled !== undefined) {
    if (typeof patch.memoryExtractEnabled !== 'boolean') {
      errors.push('memoryExtractEnabled 必须是布尔值')
    }
  }
  return errors
}

/** 读取设置；文件不存在或解析失败时返回默认值（迁移 + 填充后） */
export function loadNovaSettings(): NovaSettings {
  const path = getSettingsPath()
  if (!existsSync(path)) {
    return { ...DEFAULT_NOVA_SETTINGS }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return migrateAndFill(raw)
  } catch {
    // 解析失败：回退默认值，不阻塞启动
    return { ...DEFAULT_NOVA_SETTINGS }
  }
}

/**
 * 合并写入设置。
 * 保存前校验 patch 字段合法性，非法值抛错（含具体字段提示）。
 * 写盘时附带 settingsVersion，供未来迁移识别。
 */
export function saveNovaSettings(patch: Partial<NovaSettings>): NovaSettings {
  const errors = validatePatch(patch)
  if (errors.length > 0) {
    throw new Error(`设置校验失败：${errors.join('；')}`)
  }

  const dir = getNovaHomeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const current = loadNovaSettings()
  const next: NovaSettings & { settingsVersion?: number } = {
    ...current,
    ...patch,
    settingsVersion: CURRENT_SETTINGS_VERSION
  }
  writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  // 返回不含 settingsVersion 的纯净 dto
  const { settingsVersion: _drop, ...dto } = next
  return dto as NovaSettings
}
