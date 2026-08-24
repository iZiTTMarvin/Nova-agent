/**
 * 工具参数名别名解析。
 *
 * 背景：不同模型 / prompt 模板 / 中转服务对同一语义的参数名有不同习惯。
 * 例如路径参数，业界常见的变体有 path / filePath / file_path / file /
 * filename / target_file / target；搜索模式有 pattern / query / search / regex。
 *
 * 如果工具只认 schema 里定义的正式名，模型用了别名就会报「缺少参数」。
 * editTool 早期（commit aaed462）单独做了 7 种路径别名兼容，但没同步到其他工具，
 * 导致 find / grep / ls / bash 同样的问题反复出现。
 *
 * 本模块集中管理别名清单，所有工具通过 resolveToolArg 统一取参，
 * 避免别名清单散落在各工具里不一致。新增别名只改这里一处。
 */

/** 文件路径参数的常见别名（按优先级，正式名最前） */
const PATH_ALIASES = [
  'path',
  'filePath',
  'file_path',
  'file',
  'filename',
  'target_file',
  'target',
] as const

/** 搜索模式参数的常见别名 */
const PATTERN_ALIASES = [
  'pattern',
  'query',
  'search',
  'regex',
  'search_pattern',
  'searchPattern',
] as const

/** shell 命令参数的常见别名 */
const COMMAND_ALIASES = [
  'command',
  'cmd',
  'shell',
  'run',
] as const

/** resolveToolArg 支持的参数类别（对应 schema 里的正式参数名） */
export type ToolArgKind = 'path' | 'pattern' | 'command'

/** 各参数类别对应的别名清单（正式名最前，按优先级降序） */
const ARG_ALIASES: Record<ToolArgKind, readonly string[]> = {
  path: PATH_ALIASES,
  pattern: PATTERN_ALIASES,
  command: COMMAND_ALIASES,
}

/** 退化 Markdown 自动链接：链接文本与去协议后的 URL 完全一致（聊天分布泄漏进参数值） */
const DEGENERATE_AUTOLINK = /^\[([^\]]+)\]\(https?:\/\/([^()\s]+)\)$/

/**
 * 展开退化 Markdown 自动链接（如 `[notes.md](http://notes.md)` → `notes.md`）。
 * 仅当链接文本等于去协议 URL 时才展开；真 Markdown 链接与普通路径原样返回。
 */
export function unwrapDegenerateAutolink(value: string): string {
  const match = DEGENERATE_AUTOLINK.exec(value.trim())
  if (match && match[1] === match[2]) {
    return match[1]
  }
  return value
}

/**
 * 按别名优先级从 args 中取字符串参数。
 * 返回第一个存在的非空值；都缺失返回 undefined。
 *
 * 取值策略：
 *   1. 先扫所有别名，返回第一个「非空字符串」值（过滤掉空串）
 *   2. 都不是字符串时，取第一个「非 null/undefined」值并 String() 兜底
 *      （模型有时把路径传成 number，如 `123` → `'123'`）
 *
 * @example
 * // 取路径（兼容 path / filePath / file_path / ... ）
 * const inputPath = resolveToolArg(args, 'path')
 * // 取搜索模式（兼容 pattern / query / search / ...）
 * const pattern = resolveToolArg(args, 'pattern')
 */
export function resolveToolArg(
  args: Record<string, unknown>,
  kind: ToolArgKind
): string | undefined {
  const aliases = ARG_ALIASES[kind]

  // 第一轮：优先取非空字符串
  for (const key of aliases) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) {
      return unwrapDegenerateAutolink(value)
    }
  }
  // 第二轮：非字符串类型也兜底取（模型传 number / 布尔等）
  for (const key of aliases) {
    const value = args[key]
    if (value !== undefined && value !== null) {
      return unwrapDegenerateAutolink(String(value))
    }
  }
  return undefined
}
