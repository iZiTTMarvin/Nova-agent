/**
 * syntaxHighlight — 轻量级多语言词法高亮工具
 *
 * 职责：
 * 1. 根据文件路径或围栏语言标识识别语法分类与细分方言
 * 2. 对纯文本（plain/plaintext/text/txt）在 O(1) 时间内原样返回，不误染色
 * 3. 对主流代码、配置、脚本、样式、标记与差异文本做单行 token 级高亮
 * 4. 供 MarkdownRenderer、StreamingFileCard 和 FilesTab 共享复用
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

export type LanguageCategory = 'code' | 'json' | 'markdown' | 'shell' | 'plain'

type CodeDialect = 'general' | 'html' | 'css' | 'yaml' | 'sql' | 'diff' | 'hash-comment'

export const KEYWORDS = new Set([
  // JS / TS / 通用 C 系
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'default', 'break', 'continue', 'class', 'interface',
  'type', 'enum', 'export', 'import', 'from', 'as', 'async', 'await', 'new',
  'try', 'catch', 'finally', 'throw', 'extends', 'implements', 'public',
  'private', 'protected', 'readonly', 'static', 'abstract', 'override',
  'declare', 'namespace', 'module', 'keyof', 'typeof', 'instanceof', 'in',
  'of', 'void', 'delete', 'yield', 'this', 'super', 'true', 'false', 'null',
  'undefined',
  // Python
  'def', 'elif', 'except', 'raise', 'with', 'pass', 'lambda', 'nonlocal',
  'global', 'assert', 'and', 'or', 'not', 'is', 'None', 'True', 'False', 'self', 'cls',
  // Rust / Go / Java / C++
  'fn', 'mut', 'pub', 'impl', 'trait', 'struct', 'match', 'use', 'mod', 'crate',
  'where', 'unsafe', 'move', 'ref', 'loop', 'Self', 'func', 'package', 'defer',
  'go', 'chan', 'select', 'map', 'range', 'fallthrough', 'nil', 'final',
  'synchronized', 'volatile', 'virtual', 'constexpr', 'nullptr', 'template',
  'typename', 'using'
])

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'in', 'select', 'return', 'exit', 'local',
  'export', 'source', 'alias', 'unalias', 'readonly', 'shift', 'eval', 'exec',
  'set', 'unset', 'trap', 'wait', 'read', 'echo', 'printf', 'test', 'true', 'false'
])

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set',
  'delete', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on',
  'group', 'by', 'order', 'asc', 'desc', 'having', 'limit', 'offset', 'union',
  'all', 'distinct', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'exists',
  'between', 'like', 'ilike', 'case', 'when', 'then', 'else', 'end', 'create',
  'table', 'view', 'index', 'drop', 'alter', 'add', 'column', 'primary', 'key',
  'foreign', 'references', 'unique', 'default', 'constraint', 'begin', 'commit',
  'rollback', 'transaction', 'with', 'recursive', 'returning', 'true', 'false'
])

const CSS_KEYWORDS = new Set([
  'important', 'inherit', 'initial', 'unset', 'revert', 'auto', 'none',
  'solid', 'dashed', 'dotted', 'transparent', 'currentColor', 'flex', 'grid',
  'block', 'inline', 'relative', 'absolute', 'fixed', 'sticky', 'hidden',
  'visible', 'bold', 'normal', 'italic', 'center', 'start', 'end', 'stretch',
  'space-between', 'column', 'row', 'wrap', 'nowrap', 'pointer', 'default'
])

const YAML_KEYWORDS = new Set([
  'true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null', 'NULL'
])

const PLAIN_IDENTIFIERS = new Set([
  '', 'plain', 'plaintext', 'text', 'txt', 'log', 'csv', 'tsv', 'ascii', 'tree', 'output', 'raw'
])

const JSON_IDENTIFIERS = new Set([
  'json', 'jsonc', 'jsonl', 'geojson', 'eslintrc', 'prettierrc', 'babelrc'
])

const MARKDOWN_IDENTIFIERS = new Set([
  'md', 'markdown', 'mdx'
])

const SHELL_IDENTIFIERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'ps1', 'psm1', 'powershell',
  'pwsh', 'bat', 'cmd', 'dockerfile', 'makefile', 'mk', 'dotenv', 'env'
])

const CODE_IDENTIFIERS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'diff', 'patch',
  'py', 'python', 'pyw', 'rs', 'rust', 'go', 'golang', 'java', 'kt', 'kts', 'kotlin',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'csharp', 'swift', 'rb', 'ruby',
  'php', 'lua', 'sql', 'graphql', 'gql', 'prisma', 'proto', 'dart', 'scala', 'r',
  'openui'
])

const HTML_IDENTIFIERS = new Set(['html', 'htm', 'xml', 'svg', 'vue', 'svelte'])
const CSS_IDENTIFIERS = new Set(['css', 'scss', 'sass', 'less'])
const YAML_IDENTIFIERS = new Set(['yaml', 'yml', 'toml', 'ini', 'conf'])
const SQL_IDENTIFIERS = new Set(['sql'])
const DIFF_IDENTIFIERS = new Set(['diff', 'patch'])
const HASH_COMMENT_CODE_IDENTIFIERS = new Set([
  'py', 'python', 'pyw', 'rb', 'ruby', 'r', 'pl', 'perl', 'graphql', 'gql', 'prisma', 'openui'
])

const PATTERN_STANDARD = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\$\{[^}]+\}|\$[A-Za-z_]\w*|\b0[xX][0-9a-fA-F_]+\b|\b0[bB][01_]+\b|\b0[oO][0-7_]+\b|\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b|@[A-Za-z_]\w*|\b[A-Za-z_]\w*\b|\/\/.*|\/\*.*?\*\/|[:=+\-*/<>!&|()[\]{}.,;~?]+)/g

const PATTERN_WITH_HASH = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\$\{[^}]+\}|\$[A-Za-z_]\w*|\b0[xX][0-9a-fA-F_]+\b|\b0[bB][01_]+\b|\b0[oO][0-7_]+\b|\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?\b|@[A-Za-z_]\w*|\b[A-Za-z_]\w*\b|\/\/.*|\/\*.*?\*\/|(?<=\s|^)#.*|[:=+\-*/<>!&|()[\]{}.,;~?]+)/g

const PATTERN_SQL = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|''|\\.)*'|`(?:[^`\\]|\\.)*`|--.*|\/\*.*?\*\/|\b\d[\d_]*(?:\.[\d_]+)?\b|@[A-Za-z_]\w*|\b[A-Za-z_]\w*\b|[:=+\-*/<>!&|()[\]{}.,;~?]+)/g

/**
 * 从文件路径或语言标签提取归一化的扩展名/语言标识
 */
function extractLangKey(filePathOrLang: string): string {
  const trimmed = filePathOrLang.trim().toLowerCase()
  if (!trimmed) return ''

  const normalized = trimmed.replace(/\\/g, '/')
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1)

  if (baseName === 'dockerfile' || baseName.startsWith('dockerfile.')) return 'dockerfile'
  if (baseName === 'makefile' || baseName === 'gnumakefile') return 'makefile'
  if (baseName === '.env' || baseName.startsWith('.env.')) return 'env'

  const dotIdx = baseName.lastIndexOf('.')
  if (dotIdx >= 0 && dotIdx < baseName.length - 1) {
    return baseName.slice(dotIdx + 1)
  }
  return baseName
}

/**
 * 根据文件路径或围栏语言标识检测语言分类（大小写不敏感）
 * @param filePath 文件路径或围栏语言名
 * @returns 语言分类：code | json | markdown | shell | plain
 */
export function detectLanguage(filePath: string): LanguageCategory {
  const key = extractLangKey(filePath)
  if (PLAIN_IDENTIFIERS.has(key)) return 'plain'
  if (JSON_IDENTIFIERS.has(key)) return 'json'
  if (MARKDOWN_IDENTIFIERS.has(key)) return 'markdown'
  if (SHELL_IDENTIFIERS.has(key)) return 'shell'
  if (CODE_IDENTIFIERS.has(key)) return 'code'
  return 'plain'
}

function detectCodeDialect(langKey: string): CodeDialect {
  if (HTML_IDENTIFIERS.has(langKey)) return 'html'
  if (CSS_IDENTIFIERS.has(langKey)) return 'css'
  if (YAML_IDENTIFIERS.has(langKey)) return 'yaml'
  if (SQL_IDENTIFIERS.has(langKey)) return 'sql'
  if (DIFF_IDENTIFIERS.has(langKey)) return 'diff'
  if (HASH_COMMENT_CODE_IDENTIFIERS.has(langKey)) return 'hash-comment'
  return 'general'
}

function highlightHtmlLine(text: string): DiffToken[] {
  const tokens: DiffToken[] = []
  const pattern = /(<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|(?<=<\/?)[A-Za-z][\w:-]*|<\/?|\/?>|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b[A-Za-z_:][\w:.-]*(?=\s*=)|=)/gi
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (value.startsWith('<!--')) {
      type = 'comment'
    } else if (value.startsWith('<!')) {
      type = 'keyword'
    } else if (value === '<' || value === '</' || value === '>' || value === '/>' || value === '=') {
      type = 'operator'
    } else if (value.startsWith('"') || value.startsWith("'")) {
      type = 'string'
    } else if (index > 0 && (text[index - 1] === '<' || text.slice(Math.max(0, index - 2), index) === '</')) {
      type = 'keyword'
    } else {
      type = 'property'
    }

    tokens.push({ text: value, type })
    lastIndex = index + value.length
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), type: 'plain' })
  }
  return tokens.length > 0 ? tokens : [{ text, type: 'plain' }]
}

function highlightCssLine(text: string): DiffToken[] {
  const tokens: DiffToken[] = []
  const pattern = /(\/\*.*?\*\/|\/\/.*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|--[A-Za-z_-][\w-]*|@[A-Za-z_-][\w-]*|!important\b|#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|deg|rad|turn|s|ms|fr)?\b|\b[A-Za-z_-][\w-]*(?=\s*:)|\b[A-Za-z_-][\w-]*\b|[:;{}()[\],>+~*=|^$]+)/g
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (value.startsWith('/*') || value.startsWith('//')) {
      type = 'comment'
    } else if (value.startsWith('"') || value.startsWith("'")) {
      type = 'string'
    } else if (value.startsWith('@') || value === '!important' || CSS_KEYWORDS.has(value)) {
      type = 'keyword'
    } else if (value.startsWith('--') || (index + value.length < text.length && /^\s*:/.test(text.slice(index + value.length)))) {
      type = 'property'
    } else if (value.startsWith('#') || /^-?\d/.test(value)) {
      type = 'number'
    } else if (/^[:;{}()[\],>+~*=|^$]+$/.test(value)) {
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

function highlightYamlLine(text: string): DiffToken[] {
  if (/^\s*#/.test(text)) return [{ text, type: 'comment' }]
  if (/^\s*(?:---|\.\.\.)\s*$/.test(text)) return [{ text, type: 'keyword' }]

  const tokens: DiffToken[] = []
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$|(?<=^[ \t]*)[A-Za-z0-9_./-]+(?=\s*[:=])|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null|yes|no|on|off|True|False|Null|NULL)\b|[:[\]{},|>-])/gm
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (value.startsWith('#')) {
      type = 'comment'
    } else if (value.startsWith('"') || value.startsWith("'")) {
      type = 'string'
    } else if (/^[ \t]*$/.test(text.slice(0, index)) && /^\s*[:=]/.test(text.slice(index + value.length))) {
      type = 'property'
    } else if (/^-?\d/.test(value)) {
      type = 'number'
    } else if (YAML_KEYWORDS.has(value)) {
      type = 'keyword'
    } else if (/^[:[\]{},|>-]+$/.test(value)) {
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

function highlightDiffLine(text: string): DiffToken[] {
  if (/^@@.*@@/.test(text)) return [{ text, type: 'keyword' }]
  if (/^(?:\+\+\+|---)\s/.test(text)) return [{ text, type: 'property' }]
  if (text.startsWith('+')) return [{ text, type: 'string' }]
  if (text.startsWith('-')) return [{ text, type: 'keyword' }]
  return [{ text, type: 'plain' }]
}

/**
 * 对单行文本做轻量级 token 级语法高亮
 * @param text 待高亮的一行文本
 * @param filePath 文件路径或围栏语言标识（用于语言检测以选择高亮策略）
 * @returns DiffToken 数组，保证永不为空（至少含一个 plain token）
 */
export function highlightLine(text: string, filePath: string): DiffToken[] {
  if (!text) return [{ text: '', type: 'plain' }]

  const language = detectLanguage(filePath)
  if (language === 'plain') {
    return [{ text, type: 'plain' }]
  }

  if (language === 'markdown') {
    if (/^\s*(?:#{1,6}\s|```)/.test(text)) return [{ text, type: 'keyword' }]
    if (/^\s*[-*+]\s/.test(text)) return [{ text, type: 'operator' }]
    if (/^\s*>/.test(text)) return [{ text, type: 'comment' }]
    return [{ text, type: 'plain' }]
  }

  if (language === 'shell' && /^\s*#/.test(text)) {
    return [{ text, type: 'comment' }]
  }

  const langKey = extractLangKey(filePath)
  if (language === 'code') {
    const dialect = detectCodeDialect(langKey)
    if (dialect === 'html') return highlightHtmlLine(text)
    if (dialect === 'css') return highlightCssLine(text)
    if (dialect === 'yaml') return highlightYamlLine(text)
    if (dialect === 'diff') return highlightDiffLine(text)
    if (dialect === 'hash-comment' && /^\s*#/.test(text)) {
      return [{ text, type: 'comment' }]
    }
    if (dialect === 'sql' && /^\s*--/.test(text)) {
      return [{ text, type: 'comment' }]
    }
  }

  const isSql = langKey === 'sql'
  const supportsHashComment = language === 'shell' || HASH_COMMENT_CODE_IDENTIFIERS.has(langKey)
  const pattern = isSql ? PATTERN_SQL : supportsHashComment ? PATTERN_WITH_HASH : PATTERN_STANDARD

  const tokens: DiffToken[] = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index ?? 0

    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), type: 'plain' })
    }

    let type: TokenType = 'plain'
    if (
      value.startsWith('//') ||
      value.startsWith('/*') ||
      (isSql && value.startsWith('--')) ||
      (supportsHashComment && value.startsWith('#'))
    ) {
      type = 'comment'
    } else if (
      value.startsWith('"') || value.startsWith("'") || value.startsWith('`')
    ) {
      type = 'string'
    } else if (value.startsWith('$') || value.startsWith('@')) {
      type = 'property'
    } else if (/^\d/.test(value)) {
      type = 'number'
    } else if (
      (language === 'shell' && SHELL_KEYWORDS.has(value)) ||
      (isSql && SQL_KEYWORDS.has(value.toLowerCase())) ||
      (language !== 'json' && KEYWORDS.has(value)) ||
      (language === 'json' && (value === 'true' || value === 'false' || value === 'null'))
    ) {
      type = 'keyword'
    } else if (/^[A-Za-z_]\w*$/.test(value) && language === 'json') {
      type = 'property'
    } else if (/^[:=+\-*/<>!&|()[\]{}.,;~?]+$/.test(value)) {
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
