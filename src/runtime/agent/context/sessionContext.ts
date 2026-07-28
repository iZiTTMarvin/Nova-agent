import type { ChatMessage, ContentBlock } from '../../model/types'

/** 构造模型每个会话周期需要看到的运行环境锚点。 */
export interface SessionContextOptions {
  /** 工作区绝对路径 */
  workingDir: string
  /** 当前模型 ID */
  model: string
  /** 注入时间，默认 new Date()；单测可注入固定值 */
  date?: Date
}

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'
] as const

/**
 * 探测 OS 标签。
 *
 * 优先识别 Windows / macOS / Linux；未知平台保留 process.platform 原值。
 */
function detectOsLabel(): string {
  const platform = process.platform
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** 把日期格式化为 YYYY-MM-DD（零填充，本地时区） */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 构造会话上下文注入文本。
 *
 * 格式参考 OpenClacky：
 * `[Session context: Today is YYYY-MM-DD, Weekday. Current model: <id>. OS: <label>. Working directory: <abs path>]`
 *
 * @example
 * buildSessionContext({ workingDir: 'D:\\proj', model: 'gpt-4o', date: new Date('2026-06-15') })
 * // => "[Session context: Today is 2026-06-15, Monday. Current model: gpt-4o. OS: Windows. Working directory: D:\\proj]"
 */
export function buildSessionContext(opts: SessionContextOptions): string {
  const { workingDir, model } = opts
  const date = opts.date ?? new Date()

  const dateStr = formatDate(date)
  const weekday = WEEKDAY_NAMES[date.getDay()]
  const osLabel = detectOsLabel()

  return (
    `[Session context: Today is ${dateStr}, ${weekday}. ` +
    `Current model: ${model}. OS: ${osLabel}. ` +
    `Working directory: ${workingDir}]`
  )
}

/**
 * 提取 user 消息开头的 session context。
 * 字符串消息以空行分隔正文；多模态消息只认可首个文本块，避免正文回显误命中。
 */
export function extractSessionContextPrefix(
  content: string | ContentBlock[]
): string | null {
  if (typeof content === 'string') {
    if (!content.startsWith('[Session context:')) return null
    return content.split('\n\n')[0] ?? content
  }

  const firstBlock = content[0]
  if (!firstBlock || firstBlock.type !== 'text') return null
  return firstBlock.text.startsWith('[Session context:') ? firstBlock.text : null
}

/**
 * 仅把 user 消息开头、且与当前完整环境文本逐字相等的前缀视为有效锚点。
 */
export function hasValidSessionContextAnchor(
  messages: readonly ChatMessage[],
  expectedPrefix: string
): boolean {
  return messages.some(message =>
    message.role === 'user'
    && extractSessionContextPrefix(message.content) === expectedPrefix
  )
}
