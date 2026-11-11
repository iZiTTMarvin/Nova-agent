/**
 * 大纲取证的纯策略：候选排序、引用统计、目录概览与片段窗口。
 * 不做任何 IO，由 WorkspaceEvidencePort 喂入文件列表与文本。
 */
import { posix } from 'node:path'
import {
  LEARNING_FRAGMENT_MAX_BYTES,
  LEARNING_FRAGMENT_MAX_LINES,
  LEARNING_PACKAGE_JSON_MAX_LINES,
  LEARNING_PROJECT_LAYOUT_MAX_ENTRIES
} from '../../../../shared/learning/buildLimits'
import type { ProjectLayoutEntry } from './evidenceTypes'

export const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt'
] as const

const ENTRY_NAME =
  /(?:^|\/)(?:(?:index|main|app)\.(?:tsx?|jsx?|mjs|cjs)|(?:main|app|manage|__init__)\.py|main\.go|(?:main|lib)\.rs|main\.(?:c|cpp|cc)|program\.cs|main\.(?:java|kt|swift|rb)|index\.php)$/i
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__)\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|rs)$|\.(?:test|spec)\.[^/]+$/i
const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock'
])
const ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml']
const ROOT_READMES = ['README.md', 'readme.md', 'Readme.md']

export type EvidenceFileKind = 'code' | 'readme' | 'package_json' | 'other'

export function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext)) && !path.toLowerCase().endsWith('.d.ts')
}

export function evidenceFileKind(path: string): EvidenceFileKind {
  if (path === 'package.json') return 'package_json'
  if (/^readme\.md$/i.test(path)) return 'readme'
  return isCodePath(path) ? 'code' : 'other'
}

/** 测试、类型声明与锁文件不作为大纲证据。 */
export function isExcludedEvidencePath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return TEST_PATH.test(path) || path.toLowerCase().endsWith('.d.ts') || LOCKFILES.has(base)
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g

/** 只识别相对路径引用；包名引用与项目结构无关。 */
export function extractRelativeImports(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    if (match[1]) found.push(match[1])
  }
  return found
}

/** 按常见扩展名与 index.* 解析相对引用；ESM 源码里写 .js 指向 .ts 的情况也兼容。 */
export function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>
): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  if (base.startsWith('..')) return null
  const stem = base.replace(/\.(m?js|cjs|jsx)$/i, '')
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map(ext => stem + ext),
    ...CODE_EXTENSIONS.map(ext => `${base}/index${ext}`)
  ]
  return candidates.find(candidate => known.has(candidate)) ?? null
}

/** package.json 声明的入口（main / bin / exports），只保留真实存在的源码路径。 */
export function packageEntryPaths(packageJsonText: string, known: ReadonlySet<string>): string[] {
  let raw: unknown
  try {
    raw = JSON.parse(packageJsonText)
  } catch {
    return []
  }
  const values: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') values.push(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  const pkg = raw as Record<string, unknown>
  collect(pkg.main)
  collect(pkg.bin)
  collect(pkg.exports)
  const entries: string[] = []
  for (const value of values) {
    const normalized = posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
    const resolved = resolveRelativeImport('package.json', `./${normalized}`, known)
    if (resolved && !entries.includes(resolved)) entries.push(resolved)
  }
  return entries
}

/** 分散覆盖的分组键：代码主要在 src/ 下时按它下一级目录分组，否则按顶层目录。 */
function groupKeyOf(path: string, nestedUnderSrc: boolean): string {
  const parts = path.split('/')
  if (nestedUnderSrc && parts[0] === 'src') return parts.length > 2 ? `src/${parts[1]}` : 'src'
  return parts[0]!
}

/** 根目录非入口脚本与各类 *.config.* 是工具配置，不参与代码轮转，排到其他文本之前。 */
function isToolingConfig(path: string, entryPaths: ReadonlySet<string>): boolean {
  if (/\.config\.[^/]+$/i.test(path)) return true
  if (path.includes('/')) return false
  return !entryPaths.has(path) && !ENTRY_NAME.test(path)
}

const depthOf = (path: string): number => path.split('/').length

/**
 * 候选顺序：head 为根清单文件 / README；groups 为按目录分组的代码队列（组内入口按深度优先、
 * 其余按被引用次数），由取证方按轮次各取一个可用片段；tail 为工具配置与其他文本。
 * 轮流取保证覆盖面不被单个大目录吃光。
 */
export function rankEvidenceCandidates(params: {
  readonly paths: readonly string[]
  readonly entryPaths: ReadonlySet<string>
  readonly referenceCounts: ReadonlyMap<string, number>
}): { head: string[]; groups: string[][]; tail: string[] } {
  const eligible = params.paths.filter(path => !isExcludedEvidencePath(path))
  const manifests = ROOT_MANIFESTS.filter(doc => eligible.includes(doc))
  const readme = ROOT_READMES.find(doc => eligible.includes(doc))
  const head = [...manifests, ...(readme ? [readme] : [])]
  const allCode = eligible.filter(isCodePath)
  const code = allCode.filter(path => !isToolingConfig(path, params.entryPaths))
  const tooling = allCode.filter(path => isToolingConfig(path, params.entryPaths))
  const nestedUnderSrc = code.filter(path => path.startsWith('src/')).length * 2 >= code.length

  const score = (path: string): [number, number, number] => {
    const refs = params.referenceCounts.get(path) ?? 0
    return params.entryPaths.has(path) || ENTRY_NAME.test(path)
      ? [0, depthOf(path), -refs]
      : [1, -refs, depthOf(path)]
  }
  const compare = (a: string, b: string): number => {
    const sa = score(a)
    const sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!
    return a.localeCompare(b)
  }

  const groups = new Map<string, string[]>()
  for (const path of [...code].sort(compare)) {
    const key = groupKeyOf(path, nestedUnderSrc)
    const list = groups.get(key)
    if (list) list.push(path)
    else groups.set(key, [path])
  }
  const others = eligible
    .filter(path => !isCodePath(path) && !head.includes(path))
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
  return { head, groups: [...groups.values()], tail: [...tooling.sort(), ...others] }
}

/** 两层目录与各自文件数；只说明规模，不能当作事实出处。 */
export function buildProjectLayout(paths: readonly string[]): ProjectLayoutEntry[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.length > 1) counts.set(parts[0]!, (counts.get(parts[0]!) ?? 0) + 1)
    if (parts.length > 2) {
      const second = `${parts[0]}/${parts[1]}`
      counts.set(second, (counts.get(second) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([dir, fileCount]) => ({ dir, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.dir.localeCompare(b.dir))
    .slice(0, LEARNING_PROJECT_LAYOUT_MAX_ENTRIES)
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

const JS_TS_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/
const EXPORT_DEFAULT = /^export\s+default\b/
const PY_DECLARATION = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)\b/
const GO_DECLARATION = /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)\b/
const RUST_DECLARATION =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)\b/
const RUST_IMPL = /^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)\b/
const OOP_TYPE_DECLARATION =
  /^(?:(?:public|private|protected|internal|final|abstract|sealed|open|data|value|static|partial|actor)\s+)*(?:class|interface|struct|enum|record|object|trait|protocol|extension|module)\s+([A-Za-z_]\w*)\b/
const OOP_FN_DECLARATION =
  /^(?:(?:public|private|protected|internal|open|override|suspend|inline|mutating|static|final)\s+)*(?:fun|func|def|function)\s+([A-Za-z_]\w*)\b/
const C_FN_DECLARATION =
  /^(?:template\s*<[^>]*>\s*)?(?:(?:static|inline|extern|virtual|constexpr|const|unsigned|signed|struct|enum)\s+)*[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_]\w*)\s*\(/
const C_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch'])

function matchDeclarationSymbol(line: string): string | null | undefined {
  for (const pattern of [
    JS_TS_DECLARATION,
    PY_DECLARATION,
    GO_DECLARATION,
    RUST_DECLARATION,
    RUST_IMPL,
    OOP_TYPE_DECLARATION,
    OOP_FN_DECLARATION
  ]) {
    const match = line.match(pattern)
    if (match) return match[1] ?? null
  }
  if (EXPORT_DEFAULT.test(line)) return 'default'
  const cFn = line.match(C_FN_DECLARATION)
  if (cFn?.[1] && !C_CONTROL_KEYWORDS.has(cFn[1])) return cFn[1]
  return undefined
}

export interface FragmentWindow {
  readonly startLine: number
  readonly endLine: number
  readonly text: string
  readonly symbolLabel: string | null
}

/** 代码文件跳过开头注释与模块导入区，从第一个顶层声明开始取；只有引用/再导出的文件返回 null。 */
function codeStartLine(lines: readonly string[]): { index: number; symbol: string | null } | null {
  let inBlockComment = false
  let inTripleQuote: '"""' | "'''" | null = null
  let inImport: 'es' | 'paren' | null = null
  let firstBody = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (inTripleQuote) {
      if (trimmed.includes(inTripleQuote)) inTripleQuote = null
      continue
    }
    if (inImport === 'es') {
      if (/['"];?\s*$/.test(trimmed) || /\bfrom\s*['"]/.test(trimmed)) inImport = null
      continue
    }
    if (inImport === 'paren') {
      if (/[)\}];?\s*$/.test(trimmed)) inImport = null
      continue
    }
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#!')) continue
    if (/^#\s*(?:include|pragma)\b/.test(trimmed) || /^#\[/.test(trimmed)) continue
    if (trimmed.startsWith('#') && !/^#\s*(?:define|if|ifdef|ifndef|endif)\b/.test(trimmed)) continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      continue
    }
    if (firstBody < 0 && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
      const quote = trimmed.slice(0, 3) as '"""' | "'''"
      if (!trimmed.slice(3).includes(quote)) inTripleQuote = quote
      continue
    }
    if (/^['"]use (strict|client|server)['"];?$/.test(trimmed)) continue
    if (/^package\s+[\w.]+;?\s*$/.test(trimmed)) continue
    if (/^(?:namespace|using)\s+[\w.\\=]+(?:\s+as\s+\w+)?\s*;\s*$/.test(trimmed)) continue
    if (/^use\s+/.test(trimmed)) {
      if (trimmed.includes('{') && !/;\s*$/.test(trimmed)) inImport = 'paren'
      continue
    }
    if (/^from\s+[\w.]+\s+import\b/.test(trimmed)) {
      if (/\(\s*$/.test(trimmed) && !trimmed.includes(')')) inImport = 'paren'
      continue
    }
    if (/^import\s*\(\s*$/.test(trimmed)) {
      inImport = 'paren'
      continue
    }
    if (/^import\b/.test(trimmed) || /^export\s+(\*|\{[^}]*\}?)\s*(from\b|$)/.test(trimmed) || /^export\s+type\s+\{/.test(trimmed)) {
      const complete =
        /\bfrom\s*['"][^'"]+['"]/.test(trimmed) ||
        /^import\s*['"][^'"]+['"]/.test(trimmed)
      if (!complete) {
        const clause = trimmed.replace(/(?:#|\/\/).*$/, '').trimEnd()
        if (clause.includes('{') || clause.endsWith(',')) inImport = 'es'
      }
      continue
    }
    if (/^(?:require|require_relative)\b/.test(trimmed) || /^(const|let|var)\s+[\w${}\s,]+=\s*require\(/.test(trimmed)) continue
    if (firstBody < 0) firstBody = i
    const symbol = matchDeclarationSymbol(line)
    if (symbol !== undefined) return { index: i, symbol }
  }
  return firstBody < 0 ? null : { index: firstBody, symbol: null }
}

/** 从 startIndex 起取不超过行数与字节上限的窗口（按整行截断）。 */
function takeWindow(lines: readonly string[], startIndex: number, maxLines: number, maxBytes: number): { endIndex: number; text: string } {
  const taken: string[] = []
  let bytes = 0
  for (let i = startIndex; i < lines.length && taken.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i]!, 'utf8') + 1
    if (taken.length > 0 && bytes + size > maxBytes) break
    taken.push(lines[i]!)
    bytes += size
  }
  return { endIndex: startIndex + Math.max(taken.length, 1) - 1, text: taken.join('\n') }
}

/** 返回 null 表示文件没有值得讲的正文（例如只做再导出的入口桶文件）。 */
export function selectFragmentWindow(kind: EvidenceFileKind, content: string): FragmentWindow | null {
  const lines = content.split(/\r?\n/)
  if (kind === 'package_json') {
    const { endIndex, text } = takeWindow(lines, 0, LEARNING_PACKAGE_JSON_MAX_LINES, Number.MAX_SAFE_INTEGER)
    return { startLine: 1, endLine: endIndex + 1, text, symbolLabel: null }
  }
  if (kind === 'code') {
    const start = codeStartLine(lines)
    if (!start) return null
    const { endIndex, text } = takeWindow(lines, start.index, LEARNING_FRAGMENT_MAX_LINES, LEARNING_FRAGMENT_MAX_BYTES)
    return { startLine: start.index + 1, endLine: endIndex + 1, text, symbolLabel: start.symbol }
  }
  const { endIndex, text } = takeWindow(lines, 0, LEARNING_FRAGMENT_MAX_LINES, LEARNING_FRAGMENT_MAX_BYTES)
  return { startLine: 1, endLine: endIndex + 1, text, symbolLabel: null }
}

/** 与发布、打开出处共用的行切片；出处核对只比较这段文本。 */
export function sliceLines(content: string, startLine: number, endLine: number): { text: string; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, startLine)
  const end = Math.min(lines.length, endLine)
  if (start > lines.length) return { text: '', startLine: start, endLine: start }
  return { text: lines.slice(start - 1, end).join('\n'), startLine: start, endLine: end }
}
