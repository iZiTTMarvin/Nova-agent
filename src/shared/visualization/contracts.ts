/**
 * 会话内可视化的跨层契约：工具名、快照地址、工具结果、主题投影与帧初始化参数。
 * 快照文件是唯一事实源；工具结果与消息只保存地址引用，不内联内容。
 */

export const PRESENT_VISUALIZATION_TOOL_NAME = 'present_visualization'
export const VISUALIZATION_SCHEME = 'nova-viz'
export const MAX_VISUALIZATION_HTML_BYTES = 2 * 1024 * 1024
export const MAX_VISUALIZATION_TITLE_CHARS = 80
/** 内联形态的高度上限：超出后由产物内部滚动，聊天流不被撑开 */
export const VISUALIZATION_MAX_INLINE_HEIGHT = 720
export const VISUALIZATION_MIN_HEIGHT = 24
/** 慢动作倍率：产物内 CSS / Web Animations 的播放速率按 1/倍率 放慢 */
export const VISUALIZATION_SLOW_MOTION_SCALE = 4

/** standard scheme 会把 host 归一为小写：会话 ID 放在路径里才能无损往返，取值与 SessionStore 对齐 */
const VISUALIZATION_HOST = 'snapshot'
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SNAPSHOT_PATH_PATTERN = /^\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{64})\.html$/
const FRAME_INIT_PARAM = 'init'

export interface VisualizationAddress {
  sessionId: string
  sha256: string
}

export function isVisualizationAddress(address: VisualizationAddress): boolean {
  return SESSION_ID_PATTERN.test(address.sessionId) && SHA256_PATTERN.test(address.sha256)
}

export function isVisualizationSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId)
}

export function buildVisualizationUri(address: VisualizationAddress): string {
  if (!isVisualizationAddress(address)) {
    throw new Error(`非法的可视化地址: ${address.sessionId}/${address.sha256}`)
  }
  return `${VISUALIZATION_SCHEME}://${VISUALIZATION_HOST}/${address.sessionId}/${address.sha256}.html`
}

/** 解析快照地址；查询串只承载帧初始化参数，不参与寻址。 */
export function parseVisualizationUri(value: string): VisualizationAddress | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== `${VISUALIZATION_SCHEME}:` ||
    url.hostname !== VISUALIZATION_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null
  }
  const match = SNAPSHOT_PATH_PATTERN.exec(url.pathname)
  return match ? { sessionId: match[1], sha256: match[2] } : null
}

export interface VisualizationPresentation {
  title: string
  uri: string
  bytes: number
}

/** 工具结果正文：模型与渲染层读同一份 JSON */
export function formatVisualizationResult(presentation: VisualizationPresentation): string {
  return JSON.stringify({
    presented: true,
    title: presentation.title,
    uri: presentation.uri,
    bytes: presentation.bytes
  })
}

export function parseVisualizationResult(
  result: string | undefined
): (VisualizationPresentation & { address: VisualizationAddress }) | null {
  if (!result) return null
  let value: unknown
  try {
    value = JSON.parse(result)
  } catch {
    return null
  }
  if (!isRecord(value) || value.presented !== true) return null
  const { title, uri, bytes } = value
  if (typeof title !== 'string' || typeof uri !== 'string' || typeof bytes !== 'number') return null
  const address = parseVisualizationUri(uri)
  return address ? { title, uri, bytes, address } : null
}

export type VisualizationColorScheme = 'light' | 'dark'

/** 产物可用的主题变量（CSS 中为 --viz-<name>） */
export const VISUALIZATION_THEME_TOKENS = [
  'bg',
  'surface',
  'fg',
  'muted',
  'border',
  'accent',
  'on-accent',
  'success',
  'warning',
  'danger',
  'series-1',
  'series-2',
  'series-3',
  'series-4',
  'series-5',
  'series-6',
  'font-sans',
  'font-mono',
  'radius'
] as const

export type VisualizationThemeToken = (typeof VISUALIZATION_THEME_TOKENS)[number]

export interface VisualizationTheme {
  scheme: VisualizationColorScheme
  tokens: Record<VisualizationThemeToken, string>
}

/** 系列色不取宿主 token：图表需要彼此可辨的色相，深色档整体提亮降饱和以免刺眼。 */
export const VISUALIZATION_SERIES_PALETTE: Record<VisualizationColorScheme, readonly string[]> = {
  light: ['#2f6fe4', '#1f9d55', '#d9731a', '#8b5cf6', '#0e93a8', '#d24d8a'],
  dark: ['#7aa7ff', '#6cc58a', '#f0a35e', '#b892f5', '#5ec8d8', '#ec8fb6']
}

/** 颜色、字体栈与长度的字面值；排除可闭合 CSS 声明或 HTML 标签的字符 */
const TOKEN_VALUE_PATTERN = /^[\p{L}\p{N}\s#%(),./"'+_-]{1,200}$/u

export function isVisualizationThemeTokenValue(value: string): boolean {
  return TOKEN_VALUE_PATTERN.test(value)
}

export function parseVisualizationTheme(value: unknown): VisualizationTheme | null {
  if (!isRecord(value) || (value.scheme !== 'light' && value.scheme !== 'dark') || !isRecord(value.tokens)) {
    return null
  }
  const tokens = {} as Record<VisualizationThemeToken, string>
  for (const name of VISUALIZATION_THEME_TOKENS) {
    const token = value.tokens[name]
    if (typeof token !== 'string' || !isVisualizationThemeTokenValue(token)) return null
    tokens[name] = token
  }
  return { scheme: value.scheme, tokens }
}

export function parseVisualizationMotionScale(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10 ? value : null
}

export function parseVisualizationMaxHeight(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= VISUALIZATION_MIN_HEIGHT && value <= 10_000
    ? Math.round(value)
    : null
}

/**
 * 帧首次加载即需要的宿主状态：随 src 下发，产物脚本启动时同步可读，不依赖握手时序。
 * maxHeight 是宿主给帧的高度上限：内容未超限时产物不出滚动条，避免滚动条引起的宽度变化反复改变高度。
 */
export interface VisualizationFrameInit {
  theme: VisualizationTheme
  motionScale: number
  maxHeight: number
}

export function buildVisualizationFrameSrc(uri: string, init: VisualizationFrameInit): string {
  return `${uri}?${FRAME_INIT_PARAM}=${encodeURIComponent(JSON.stringify(init))}`
}

export function parseVisualizationFrameInit(url: string): VisualizationFrameInit | null {
  let raw: string | null
  try {
    raw = new URL(url).searchParams.get(FRAME_INIT_PARAM)
  } catch {
    return null
  }
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const theme = parseVisualizationTheme(value.theme)
  const motionScale = parseVisualizationMotionScale(value.motionScale)
  const maxHeight = parseVisualizationMaxHeight(value.maxHeight)
  return theme && motionScale !== null && maxHeight !== null ? { theme, motionScale, maxHeight } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
