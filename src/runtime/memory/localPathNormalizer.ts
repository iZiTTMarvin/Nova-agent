/** 记忆跨机器复用，本机根路径归一为 <workspace> / <temp> / ~。 */
export interface LocalPathRoots {
  workspaceRoot?: string
  tempDir: string
  homeDir: string
}

const PLACEHOLDERS = [
  ['workspaceRoot', '<workspace>'],
  ['tempDir', '<temp>'],
  ['homeDir', '~']
] as const

// 路径与周围文本的分隔字符（空白、引号、括号、赋值与重定向符号等）
const DELIMITERS = '\\s"\'`=,;:|()\\[\\]{}<>'
// 根之前须是分隔符或行首：避免命中更长路径中间的同名片段
const SEGMENT_PRECEDES = `(?<![^${DELIMITERS}])`
// 根之后须是分隔符、路径分隔符或行尾：根后紧跟段内字符说明是同名前缀的另一个目录
const SEGMENT_CONTINUES = `(?![^\\\\/${DELIMITERS}])`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 分隔符按 `[\\/]+` 匹配，覆盖正反斜杠混写与 JSON 转义后的双反斜杠 */
function rootPattern(root: string): string | null {
  const segments = root.split(/[\\/]+/).filter(segment => segment.length > 0)
  if (segments.length === 0) return null
  const body = segments.map(escapeRegExp).join('[\\\\/]+')
  return root.startsWith('/') || root.startsWith('\\') ? `[\\\\/]+${body}` : body
}

export function createLocalPathNormalizer(
  roots: LocalPathRoots,
  platform: NodeJS.Platform = process.platform
): (text: string) => string {
  const rules = PLACEHOLDERS
    .flatMap(([key, placeholder]) => {
      const root = roots[key]
      if (!root) return []
      const pattern = rootPattern(root)
      return pattern === null ? [] : [{ pattern, placeholder, length: root.length }]
    })
    // 工作区、临时目录常位于主目录之下：长根优先替换
    .sort((a, b) => b.length - a.length)
    .map(rule => ({
      regex: new RegExp(`${SEGMENT_PRECEDES}${rule.pattern}${SEGMENT_CONTINUES}`, platform === 'win32' ? 'gi' : 'g'),
      placeholder: rule.placeholder
    }))

  return (text: string) => rules.reduce((current, rule) => current.replace(rule.regex, rule.placeholder), text)
}
