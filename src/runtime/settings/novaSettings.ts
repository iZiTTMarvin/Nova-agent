/**
 * Nova 全局设置持久化（~/.nova/settings.json）
 * Task 5/13：第三方 skill 开关等应用级配置
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/** 应用级设置字段 */
export interface NovaSettings {
  /** 是否加载 Claude Code 第三方 skill（Task 13 运行时读取） */
  loadThirdPartySkills: boolean
}

const DEFAULT_SETTINGS: NovaSettings = {
  loadThirdPartySkills: true
}

/** 返回 ~/.nova 目录路径 */
export function getNovaHomeDir(): string {
  return join(homedir(), '.nova')
}

function getSettingsPath(): string {
  return join(getNovaHomeDir(), 'settings.json')
}

/** 读取设置；文件不存在或解析失败时返回默认值 */
export function loadNovaSettings(): NovaSettings {
  const path = getSettingsPath()
  if (!existsSync(path)) {
    return { ...DEFAULT_SETTINGS }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<NovaSettings>
    return {
      loadThirdPartySkills: raw.loadThirdPartySkills ?? DEFAULT_SETTINGS.loadThirdPartySkills
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 合并写入设置 */
export function saveNovaSettings(patch: Partial<NovaSettings>): NovaSettings {
  const dir = getNovaHomeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const next = { ...loadNovaSettings(), ...patch }
  writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
