/**
 * Edit 文本定位：exact → line-trimmed → whitespace → escape。
 * 模糊策略仅在唯一全量 span 时接受；歧义或不对称尺寸一律拒绝，不猜测位置。
 */

export type EditMatchStrategy = 'exact' | 'line-trimmed' | 'whitespace' | 'escape'

export interface EditMatchResult {
  /** 源文件中实际命中的原文片段（写入时按此 span 替换） */
  span: string
  matchedVia: EditMatchStrategy
  startOffset: number
}

export class EditMatchError extends Error {
  readonly code:
    | 'not_found'
    | 'not_unique'
    | 'ambiguous'
    | 'too_short'
    | 'binary'
    | 'too_large'
    | 'disproportionate'
    | 'empty'

  constructor(
    code: EditMatchError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'EditMatchError'
    this.code = code
  }
}

const MIN_FUZZY_OLD_STRING_LENGTH = 5
const MAX_FUZZY_SOURCE_CHARS = 1_000_000
const MAX_FUZZY_SOURCE_LINES = 50_000

/**
 * 在 source 中定位 oldString 的唯一匹配片段。
 * exact 不受模糊门控；模糊策略失败时抛 EditMatchError，不返回多个候选。
 */
export function findUniqueEditMatch(
  source: string,
  oldString: string,
  where: string = 'file',
): EditMatchResult {
  if (oldString === '') {
    throw new EditMatchError('empty', `oldText must not be empty in "${where}"`)
  }

  const exactCount = countOccurrences(source, oldString)
  if (exactCount === 1) {
    return finish(source, oldString, 'exact')
  }
  if (exactCount > 1) {
    throw new EditMatchError(
      'not_unique',
      `oldText appears ${exactCount} times in "${where}". Include more context to make it unique.`,
    )
  }

  if (oldString.trim().length < MIN_FUZZY_OLD_STRING_LENGTH) {
    throw new EditMatchError(
      'too_short',
      `oldText is too short for a non-exact match in "${where}"; provide a longer, exact snippet`,
    )
  }
  if (source.includes('\0')) {
    throw new EditMatchError(
      'binary',
      `Refusing a non-exact match in "${where}": the file looks binary (contains a NUL byte). Re-read it and pass exact text.`,
    )
  }
  if (
    source.length > MAX_FUZZY_SOURCE_CHARS ||
    countOccurrences(source, '\n') + 1 > MAX_FUZZY_SOURCE_LINES
  ) {
    throw new EditMatchError(
      'too_large',
      `Refusing a non-exact match in "${where}": the file is too large to fuzzy-match safely. Re-read it and pass exact text.`,
    )
  }

  const strategies: Array<[EditMatchStrategy, (content: string, find: string) => string[]]> = [
    ['line-trimmed', lineTrimmedSpans],
    ['whitespace', whitespaceNormalizedSpans],
    ['escape', escapeNormalizedSpans],
  ]

  for (const [name, finder] of strategies) {
    const spans = dedupeInContent(source, finder(source, oldString))
    if (spans.length === 0) continue
    if (spans.length > 1) {
      throw new EditMatchError(
        'ambiguous',
        `oldText matched ${spans.length} different ${name} candidates in "${where}"; provide more exact context to disambiguate`,
      )
    }
    const span = spans[0]!
    if (source.indexOf(span) !== source.lastIndexOf(span)) {
      throw new EditMatchError(
        'ambiguous',
        `oldText matched a ${name} span that occurs more than once in "${where}"; provide more exact context to disambiguate`,
      )
    }
    if (isDisproportionate(span, oldString)) {
      throw new EditMatchError(
        'disproportionate',
        `Refusing ${name} match in "${where}": the matched span is much larger than oldText. Re-read the file and pass the exact text to replace.`,
      )
    }
    return finish(source, span, name)
  }

  throw new EditMatchError(
    'not_found',
    `oldText not found in "${where}"; it must match the file's text including whitespace and indentation`,
  )
}

function finish(
  content: string,
  span: string,
  matchedVia: EditMatchStrategy,
): EditMatchResult {
  const startOffset = content.indexOf(span)
  return { span, matchedVia, startOffset }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function dedupeInContent(content: string, candidates: string[]): string[] {
  const out: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    if (content.indexOf(candidate) === -1) continue
    if (out.indexOf(candidate) === -1) out.push(candidate)
  }
  return out
}

function lineTrimmedSpans(content: string, find: string): string[] {
  const out: string[] = []
  const originalLines = content.split('\n')
  const findEndsWithNewline = find.endsWith('\n')
  const searchLines = find.split('\n')
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }
  if (searchLines.length === 0) return out
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue
    let startIndex = 0
    for (let k = 0; k < i; k++) startIndex += originalLines[k]!.length + 1
    let endIndex = startIndex
    for (let k = 0; k < searchLines.length; k++) {
      endIndex += originalLines[i + k]!.length
      if (k < searchLines.length - 1) endIndex += 1
    }
    if (findEndsWithNewline) {
      const lastLine = i + searchLines.length - 1
      if (lastLine >= originalLines.length - 1) continue
      endIndex += 1
    }
    out.push(content.substring(startIndex, endIndex))
  }
  return out
}

function whitespaceNormalizedSpans(content: string, find: string): string[] {
  const out: string[] = []
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalize(find)
  if (normalizedFind === '') return out
  const lines = content.split('\n')
  const findLines = find.split('\n')
  if (findLines.length === 1) {
    for (let i = 0; i < lines.length; i++) {
      if (normalize(lines[i]!) === normalizedFind) out.push(lines[i]!)
    }
  } else {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n')
      if (normalize(block) === normalizedFind) out.push(block)
    }
  }
  return out
}

function escapeNormalizedSpans(content: string, find: string): string[] {
  const out: string[] = []
  const unescape = (str: string) =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match: string, ch: string) => {
      if (ch === 'n') return '\n'
      if (ch === 't') return '\t'
      if (ch === 'r') return '\r'
      if (ch === "'") return "'"
      if (ch === '"') return '"'
      if (ch === '`') return '`'
      if (ch === '\\') return '\\'
      if (ch === '\n') return '\n'
      if (ch === '$') return '$'
      return match
    })
  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) out.push(unescapedFind)
  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    if (unescape(block) === unescapedFind) out.push(block)
  }
  return out
}

function isDisproportionate(span: string, find: string): boolean {
  const oldLines = find.split('\n').length
  const spanLines = span.split('\n').length
  if (spanLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4)
}

/**
 * 可回退到调用方既有 exact-after-transform 路径的失败。
 * 模糊门控失败只表示跳过 fuzzy，不表示全文不可编辑。
 */
export function isEditMatchFallbackAllowed(err: EditMatchError): boolean {
  return (
    err.code === 'not_found'
    || err.code === 'too_short'
    || err.code === 'binary'
    || err.code === 'too_large'
  )
}
