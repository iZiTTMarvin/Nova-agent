/**
 * sessionContext — 会话上下文注入文本构造（纯函数）
 *
 * 目标问题：模型在 system prompt 6 层里看不到工作区绝对路径，只能从 ls 等工具
 * 返回的相对路径自行脑补，进而产生"我不在工作区"的认知层判断错误。
 *
 * 修复路线（v2 合并方案，对标 OpenClacky `inject_session_context`）：
 * 把本函数返回的文本拼到每轮第一条 user 消息的 content 前缀，承载日期 / 模型 /
 * OS / 工作区绝对路径。它是真实 user 消息的一部分（不标 internal），模型能真正看到。
 *
 * v1 曾用 internal:true 独立消息注入，但 internal 消息会被序列化层整条过滤，
 * 导致 session context 到不了模型——已废弃。详见 docs/architecture/session-context-injection.md。
 *
 * 设计约束：
 * - 纯函数，**不**读全局状态，方便单测
 * - 文本格式稳定（不随时间漂移的部分固定在前半），便于缓存前缀匹配
 * - OS / 模型 / 工作区是认知锚点，日期会变但每天只注入一次（跨日去重见 AgentLoop）
 *
 * @see AgentLoop.getSessionContextPrefix 注入点
 */
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
 * 优先识别 Windows / macOS / Linux 三大类；未知平台回退到 process.platform 原值，
 * 让模型至少拿到一个明确信号而非空白。后续可抽成独立的 EnvironmentDetector。
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
