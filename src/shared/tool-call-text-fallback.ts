/**
 * tool-call-text-fallback — 把模型误输出的“伪工具调用”收口成可执行结构。
 *
 * 背景：
 * 某些模型或 provider 不会走原生 tool_call 通道，而是把调用直接混在正文里输出：
 *
 * - OpenAI 风格末尾 fenced JSON：
 *   ```json
 *   { "name": "list_directory", "arguments": { "path": "." } }
 *   ```
 *
 * - 行内 JSON（MiniMax-M3 常见）：
 *   "Let me check... { "name": "directory_tree", "arguments": {"path": ".", "max_depth": 3} }"
 *
 * - MiniMax XML 风格（M3 典型输出）：
 *   "<tool_call>[...]|<invoke name=\"bash\"><command>dir</command></invoke>[/tool_call]"
 *
 * 这些伪调用会让对话停在“我要去看一下”而不真正执行工具。这里提供兜底：
 * - 识别消息中零或多个伪工具调用（JSON 或 XML）
 * - 只接受 { name, arguments } 或 <invoke name=...>...</invoke> 这类明显形态
 * - 只映射到本项目已知工具名，避免把普通 JSON 误判成工具调用
 */

/** 文本兜底解析后得到的工具调用 */
export interface ParsedTextToolCall {
  toolName: string
  rawToolName: string
  arguments: Record<string, unknown>
}

/** 一次解析的结果：调用列表 + 给用户看的文本 */
export interface ParsedTextToolCalls {
  toolCalls: ParsedTextToolCall[]
  visibleText: string
}

/** 项目内工具的别名映射，兼容常见模型“脑补”的名字。 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  ls: 'ls',
  list_directory: 'ls',
  listdirectory: 'ls',
  listdir: 'ls',
  listfiles: 'ls',
  listfolder: 'ls',
  listworkspace: 'ls',
  readdir: 'ls',
  list_files: 'ls',

  directorytree: 'ls',
  directory_tree: 'ls',
  tree: 'ls',
  filetree: 'ls',
  file_tree: 'ls',
  showtree: 'ls',
  show_tree: 'ls',
  printtree: 'ls',
  print_tree: 'ls',
  listdirectorytree: 'ls',
  list_directory_tree: 'ls',

  read: 'read',
  readfile: 'read',
  openfile: 'read',
  viewfile: 'read',
  catfile: 'read',
  read_file: 'read',

  grep: 'grep',
  searchfiles: 'grep',
  searchfile: 'grep',
  searchinfiles: 'grep',
  searchtext: 'grep',
  findtext: 'grep',
  ripgrep: 'grep',
  search_files: 'grep',

  find: 'find',
  findfile: 'find',
  findfiles: 'find',
  locatefile: 'find',

  edit: 'edit',
  editfile: 'edit',
  modifyfile: 'edit',
  patchfile: 'edit',

  write: 'write',
  writefile: 'write',
  createfile: 'write',
  savefile: 'write',

  bash: 'bash',
  shell: 'bash',
  terminal: 'bash',
  runcommand: 'bash',
  executecmd: 'bash',
  executecommand: 'bash',
  runshellcommand: 'bash',

  // 常见模型对 invoke_skill 的误写
  invokeskill: 'invoke_skill',
  invoke_skill: 'invoke_skill',
  skill: 'invoke_skill',
  usetool: 'invoke_skill',
  use_tool: 'invoke_skill'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统一大小写、snake_case、camelCase、kebab-case 等命名风格。 */
function normalizeToolNameKey(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 把模型脑补出来的工具名映射回项目真实工具名。 */
export function normalizeFallbackToolName(name: string): string | null {
  const normalized = normalizeToolNameKey(name)
  return TOOL_NAME_ALIASES[normalized] ?? null
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null

  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parsePayload(payloadText: string): ParsedTextToolCall | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const functionPayload = isRecord(parsed.function) ? parsed.function : null
  const rawToolName =
    (typeof parsed.name === 'string' && parsed.name) ||
    (typeof parsed.tool === 'string' && parsed.tool) ||
    (typeof parsed.tool_name === 'string' && parsed.tool_name) ||
    (typeof functionPayload?.name === 'string' && functionPayload.name)

  if (!rawToolName) return null

  const toolName = normalizeFallbackToolName(rawToolName)
  if (!toolName) return null

  const directArgs =
    parsed.arguments ??
    parsed.args ??
    parsed.parameters ??
    parsed.input ??
    functionPayload?.arguments

  const argumentsObject = parseArguments(directArgs)
  if (argumentsObject) {
    return { toolName, rawToolName, arguments: argumentsObject }
  }

  // 兼容 `{ "name": "read_file", "path": "src/a.ts" }` 这种扁平写法。
  const {
    name: _name,
    tool: _tool,
    tool_name: _toolName,
    arguments: _arguments,
    args: _args,
    parameters: _parameters,
    input: _input,
    function: _function,
    ...rest
  } = parsed
  return Object.keys(rest).length > 0 ? { toolName, rawToolName, arguments: rest } : null
}

function parseInlineJsonToolCall(text: string): { prefix: string; calls: ParsedTextToolCall[]; suffix: string } | null {
  const calls: ParsedTextToolCall[] = []
  let lastIndex = 0
  const segments: string[] = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue

    // 用栈找到配对的 '}'，支持嵌套 JSON
    let depth = 0
    let endIdx = text.length
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') {
        depth--
        if (depth === 0) {
          endIdx = j + 1
          break
        }
      }
    }
    if (endIdx > text.length) continue

    const candidate = text.slice(i, endIdx)
    const parsed = parsePayload(candidate)
    if (!parsed) continue

    calls.push(parsed)
    segments.push(text.slice(lastIndex, i))
    lastIndex = endIdx
    i = endIdx - 1
  }
  segments.push(text.slice(lastIndex))

  if (calls.length === 0) return null

  const visibleText = segments
    .join('')
    .replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()

  return { prefix: '', calls, suffix: visibleText }
}

/** 解析 fenced JSON block，返回 {prefix, call}。 */
function parseFencedJsonToolCall(text: string): { prefix: string; calls: ParsedTextToolCall[] } | null {
  const trimmed = text.trimEnd()
  const match = trimmed.match(/([\s\S]*?)```(?:json|tool|tool_call)?\s*([\s\S]*?)\s*```\s*$/i)
  if (!match) return null

  const payload = match[2] ?? ''
  const parsed = parsePayload(payload)
  if (!parsed) return null

  return { prefix: (match[1] ?? '').trimEnd(), calls: [parsed] }
}

/**
 * 解析 MiniMax / 某些国产模型输出的 XML 风格工具调用。
 *
 * 典型格式：
 *   <invoke name="bash"><command>dir</command><description>...</description></invoke>
 * 或包装在 <tool_call> / <minimax> 标签内，这里只解析 <invoke> 实体。
 */
function parseInlineXmlToolCalls(text: string): { visibleText: string; calls: ParsedTextToolCall[] } | null {
  const invokeRegex = /<invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
  const calls: ParsedTextToolCall[] = []
  let lastIndex = 0
  const segments: string[] = []

  let match: RegExpExecArray | null
  while ((match = invokeRegex.exec(text)) !== null) {
    const rawToolName = match[1]
    const toolName = normalizeFallbackToolName(rawToolName)
    if (!toolName) {
      segments.push(text.slice(lastIndex, invokeRegex.lastIndex))
      lastIndex = invokeRegex.lastIndex
      continue
    }

    const innerXml = match[2]
    const args: Record<string, unknown> = {}
    const childRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g
    let childMatch: RegExpExecArray | null
    while ((childMatch = childRegex.exec(innerXml)) !== null) {
      const key = childMatch[1]
      const value = childMatch[2].trim()
      // 尝试 JSON 解析，否则存原始字符串
      try {
        args[key] = JSON.parse(value)
      } catch {
        args[key] = value
      }
    }

    calls.push({ toolName, rawToolName, arguments: args })
    segments.push(text.slice(lastIndex, match.index))
    lastIndex = invokeRegex.lastIndex
  }
  segments.push(text.slice(lastIndex))

  if (calls.length === 0) return null

  const visibleText = segments
    .join('')
    .replace(/<tool_call>|<\/tool_call>|<minimax>|<\/minimax>/gi, '')
    .replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '\n\n')
    .trim()

  return { visibleText, calls }
}

/**
 * 从 assistant 文本中提取所有“伪工具调用”。
 *
 * 支持：
 * - 末尾 fenced JSON 代码块（单条）
 * - 行内 JSON 对象（零或多条）
 * - 行内 XML <invoke>（零或多条）
 *
 * 策略：优先处理末尾 fenced JSON；否则按“行内 JSON 或 XML”解析。
 * 行内解析以调用次数最多者为准。
 */
export function parseTextToolCalls(text: string): ParsedTextToolCalls | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null

  // 1. 末尾 fenced JSON：单条最常见
  const fenced = parseFencedJsonToolCall(text)
  if (fenced) {
    return { toolCalls: fenced.calls, visibleText: fenced.prefix }
  }

  // 2. 行内解析：分别尝试 JSON 和 XML
  const inlineJson = parseInlineJsonToolCall(text)
  const inlineXml = parseInlineXmlToolCalls(text)

  const jsonCount = inlineJson?.calls.length ?? 0
  const xmlCount = inlineXml?.calls.length ?? 0

  if (jsonCount === 0 && xmlCount === 0) return null

  if (jsonCount >= xmlCount) {
    return {
      toolCalls: inlineJson!.calls,
      visibleText: inlineJson!.suffix
    }
  }

  return {
    toolCalls: inlineXml!.calls,
    visibleText: inlineXml!.visibleText
  }
}

/** 兼容旧 API：只返回第一条伪工具调用。 */
export function parseTextToolCall(text: string): ParsedTextToolCall | null {
  const result = parseTextToolCalls(text)
  return result?.toolCalls[0] ?? null
}

/** 去掉 assistant 文本中所有伪工具调用，仅保留给用户看的前置说明。 */
export function stripTextToolCalls(text: string): string {
  return parseTextToolCalls(text)?.visibleText ?? text
}

/** 兼容旧 API：去掉末尾单条伪工具调用。 */
export function stripTextToolCall(text: string): string {
  return stripTextToolCalls(text)
}
