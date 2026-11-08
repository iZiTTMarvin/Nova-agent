import type { Mode } from './types'

const STRICT_MODES: readonly Mode[] = ['plan', 'default', 'pilot', 'learn']

/** 当前 schema 读取：未知 mode 拒绝，不把 learn 回落为 default。 */
export function parseStrictMode(value: unknown): Mode {
  if (value === 'plan' || value === 'default' || value === 'pilot' || value === 'learn') {
    return value
  }
  throw new Error(`会话 mode 非法: ${String(value)}`)
}

export function isStrictMode(value: unknown): value is Mode {
  return STRICT_MODES.includes(value as Mode)
}

/** ModeSwitch 可切换的开发姿态；switch_mode 只处理 plan ↔ default，learn 不在此集合。 */
export type DevelopmentMode = 'plan' | 'default' | 'pilot'

export function isDevelopmentMode(mode: Mode): mode is DevelopmentMode {
  return mode === 'plan' || mode === 'default' || mode === 'pilot'
}

export function isAgentSwitchableMode(mode: unknown): mode is 'plan' | 'default' {
  return mode === 'plan' || mode === 'default'
}

export function assertSessionModeMutable(previous: Mode, next: Mode): void {
  if (previous === next) return
  if (previous === 'learn' || next === 'learn') {
    throw new Error('学习会话与开发会话的模式不能互相转换，请新建或选择对应会话')
  }
}
