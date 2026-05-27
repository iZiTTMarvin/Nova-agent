/**
 * syntaxHighlight — 共享语法高亮工具
 *
 * 职责：
 * 1. 根据文件路径检测语言类型
 * 2. 对单行文本做轻量级 token 级高亮
 * 3. 供 DiffViewer 和 StreamingFileCard 复用
 */

export type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'operator'
  | 'property'

export interface DiffToken {
  text: string
  type: TokenType
}

export const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'class', 'interface', 'type', 'export',
  'import', 'from', 'async', 'await', 'new', 'try', 'catch', 'finally', 'throw',
  'extends', 'implements', 'public', 'private', 'protected', 'readonly', 'true',
  'false', 'null', 'undefined'
])

/**
 * 根据文件路径后缀检测语言类型（大小写不敏感）
 * @param filePath 文件路径
 * @returns 语言分类：code | json | markdown | shell | plain
 */
export function detectLanguage(filePath: string): 'code' | 'json' | 'markdown' | 'shell' | 'plain' {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.ps1')) return 'shell'
  if (
    lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') ||
    lower.endsWith('.jsx') || lower.endsWith('.css') || lower.endsWith('.html')
  ) {
    return 'code'
  }
  return 'plain'
}

/**
 * 对单行文本做轻量级 token 级语法高亮
 * @param text 待高亮的一行文本
 * @param filePath 文件路径（用于语言检测以选择高亮策略）
 * @returns DiffToken 数组，保证永不为空（至少含一个 plain token）
 */
export function highlightLine(text: string, filePath: string): DiffToken[] {
  const language = detectLanguage(filePath)
  if (!text) return [{ text: '', type: 'plain' }]

  if (language === 'markdown') {
    if (/^\s*#{1,6}\s/.test(text)) return [{ text, type: 'keyword' }]
    if (/^\s*[-*]\s/.test(text)) return [{ text, type: 'operator' }]
    if (/^\s*>/.test(text)) return [{ text, type: 'comment' }]
    return [{ text, type: 'plain' }]
  }

  if (language === 'shell') {
    if (/^\s*#/.test(text)) return [{ text, type: 'comment' }]
  }

  const tokens: DiffToken[] = []
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\/\/.*|\/\*.*?\*\/|[:=+\-*/<>!&|()[\]{}.,])/g
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (value.startsWith('//') || value.startsWith('/*') || (language === 'shell' && value.startsWith('#'))) {
      type = 'comment'
    } else if (
      value.startsWith('"') || value.startsWith("'") || value.startsWith('`')
    ) {
      type = 'string'
    } else if (/^\d/.test(value)) {
      type = 'number'
    } else if (KEYWORDS.has(value)) {
      type = 'keyword'
    } else if (/^[A-Za-z_]\w*$/.test(value) && language === 'json') {
      type = 'property'
    } else if (/^[:=+\-*/<>!&|()[\]{}.,]+$/.test(value)) {
      type = 'operator'
    }

    tokens.push({ text: value, type })
    lastIndex = index + value.length
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), type: 'plain' })
  }

  return tokens.length > 0 ? tokens : [{ text, type: 'plain' }]
}
