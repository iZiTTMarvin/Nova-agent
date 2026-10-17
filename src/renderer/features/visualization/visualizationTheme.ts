/**
 * 宿主主题 → 可视化主题的投影：把 Nova 的语义 token 解析为产物可直接使用的字面值。
 * 宿主 token 多以 light-dark() 声明，只有挂进文档求值后才有确定颜色，因此用探针元素读取计算值。
 */
import { useSyncExternalStore } from 'react'
import {
  isVisualizationThemeTokenValue,
  VISUALIZATION_SERIES_PALETTE,
  type VisualizationColorScheme,
  type VisualizationTheme,
  type VisualizationThemeToken
} from '../../../shared/visualization'

type ColorToken = Exclude<VisualizationThemeToken, `series-${number}` | 'font-sans' | 'font-mono' | 'radius'>

const COLOR_SOURCES: Record<ColorToken, string> = {
  bg: '--bg-card',
  surface: '--surface-muted',
  fg: '--text-primary',
  muted: '--text-secondary',
  border: '--border-strong',
  accent: '--accent-primary',
  'on-accent': '--surface-canvas',
  success: '--accent-running',
  warning: '--accent-warning',
  danger: '--accent-error'
}

const LITERAL_SOURCES = {
  'font-sans': ['--font-sans', 'system-ui, sans-serif'],
  'font-mono': ['--font-mono', 'ui-monospace, monospace'],
  radius: ['--radius-md', '8px']
} as const

/** 读不到宿主值时退回系统色：产物里的 color-scheme 会让它们随深浅色求值 */
const SYSTEM_COLOR_FALLBACK: Record<ColorToken, string> = {
  bg: 'Canvas',
  surface: 'Canvas',
  fg: 'CanvasText',
  muted: 'GrayText',
  border: 'GrayText',
  accent: 'AccentColor',
  'on-accent': 'AccentColorText',
  success: 'CanvasText',
  warning: 'CanvasText',
  danger: 'CanvasText'
}

const THEME_ATTRIBUTES = ['data-theme', 'class', 'style']

function readVisualizationTheme(): VisualizationTheme {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)
  try {
    const computed = getComputedStyle(probe)
    probe.style.color = 'light-dark(rgb(0, 0, 0), rgb(255, 255, 255))'
    const scheme: VisualizationColorScheme = computed.color === 'rgb(0, 0, 0)' ? 'light' : 'dark'
    const tokens = {} as Record<VisualizationThemeToken, string>
    for (const [token, source] of Object.entries(COLOR_SOURCES) as Array<[ColorToken, string]>) {
      probe.style.color = `var(${source})`
      tokens[token] = acceptToken(computed.color, SYSTEM_COLOR_FALLBACK[token])
    }
    VISUALIZATION_SERIES_PALETTE[scheme].forEach((color, index) => {
      tokens[`series-${index + 1}` as VisualizationThemeToken] = color
    })
    const root = getComputedStyle(document.documentElement)
    for (const [token, [source, fallback]] of Object.entries(LITERAL_SOURCES)) {
      tokens[token as VisualizationThemeToken] = acceptToken(root.getPropertyValue(source).trim(), fallback)
    }
    return { scheme, tokens }
  } finally {
    probe.remove()
  }
}

function acceptToken(value: string, fallback: string): string {
  return value && isVisualizationThemeTokenValue(value) ? value : fallback
}

let snapshot: VisualizationTheme | null = null
let snapshotKey = ''
const listeners = new Set<() => void>()
let stopWatching: (() => void) | null = null

function refresh(): void {
  const next = readVisualizationTheme()
  const key = JSON.stringify(next)
  if (key === snapshotKey) return
  snapshot = next
  snapshotKey = key
  listeners.forEach(listener => listener())
}

function watchHostTheme(): () => void {
  const observer = new MutationObserver(refresh)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES })
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener('change', refresh)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', refresh)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopWatching) {
    stopWatching = watchHostTheme()
    // 无订阅期间主题可能已变化
    refresh()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }
}

export function getVisualizationTheme(): VisualizationTheme {
  if (!snapshot || !stopWatching) {
    const next = readVisualizationTheme()
    const key = JSON.stringify(next)
    if (key !== snapshotKey) {
      snapshot = next
      snapshotKey = key
    }
  }
  return snapshot as VisualizationTheme
}

export function useVisualizationTheme(): VisualizationTheme {
  return useSyncExternalStore(subscribe, getVisualizationTheme)
}
