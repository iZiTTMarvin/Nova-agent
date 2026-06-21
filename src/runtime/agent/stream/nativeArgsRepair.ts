/**
 * Native 工具调用参数修复层。
 *
 * 背景：部分模型 / 中转服务（尤其在 native function calling 协议下）会把模型
 * 生成的 XML 工具调用原样塞进 OpenAI 协议的 `function.arguments` 字段，且未做
 * JSON 转义。前端 `JSON.parse(arguments)` 之后参数对象结构彻底错位：
 *
 *   - toolName 正确（如 "edit"）
 *   - arguments 解析后的对象 key 变成整串 `invoke name="edit"`、或闭合标签
 *     残片 `/path`、`/parameter`
 *   - value 是未闭合的 XML 片段（如 `\n<parameter name="filePath">index.html`，
 *     连 </parameter> 都没有）
 *
 * 此时 `args.filePath` / `args.path` 全是 undefined，工具报「缺少 path 参数」。
 *
 * 之前只在 XML inband 方言路径（xmlToolScanner）做过适配；native 路径从 S3 至今
 * 从未加固，这是本模块要治本的缺口。
 *
 * 修复策略：复用 XmlToolScanner 增量状态机（它对未闭合标签、entity 跨 chunk、
 * MiniMax 占位符都有处理），把损坏的 arguments 字符串拼装成候选 XML 喂给 scanner，
 * 取同名调用覆盖原 args。无法修复时保持原状，不破坏正常流程。
 *
 * 设计原则：
 *   - 纯函数，无副作用，返回修复后的 args（正常情况返回原对象引用）
 *   - 不依赖 tool schema（schema 仅作为可选的辅助校验）
 *   - 对正常 native 调用（标准 JSON args）零开销短路
 */

import { XmlToolScanner, parseXmlToolCalls, stripMinimaxArtifacts, type XmlScanEvent } from './xmlToolScanner'
import type { ChatToolCall } from '../../model/types'
import { parseTextToolCalls } from '../../../shared/tool-call-text-fallback'

/** 坏 args 的 XML 标签特征 */
const INVOKE_HINT = /<invoke\b/i
const PARAMETER_HINT = /<parameter\b/i
/** 任何 XML 标签起始特征（含闭合标签 </） */
const ANY_TAG_HINT = /<[\/a-zA-Z]/

/** 出现在坏 args 里的非法 key 特征（含尖括号 / 引号 / 反斜杠 / 斜杠前缀） */
const BAD_KEY_PATTERN = /[<>"/\\]/
/** 标准合法 key：纯标识符（字母/数字/下划线，首字符非数字） */
const VALID_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * 判断一个 native tool_call 的 arguments 是否为损坏数据，需要重解析。
 *
 * 命中任一条件即判定为坏：
 *   1. arguments 字符串本身含 `<invoke` / `<parameter`（整段被塞成 XML）
 *   2. 空对象 + arguments 含裸标签前缀（未闭合标签残片）
 *   3. 解析后的对象存在任何非法 key（带尖括号 / 斜杠前缀 / 引号）
 */
export function needsRepair(argumentsStr: string, parsed: Record<string, unknown>): boolean {
  if (INVOKE_HINT.test(argumentsStr) || PARAMETER_HINT.test(argumentsStr)) {
    return true
  }

  const keys = Object.keys(parsed)
  if (keys.length === 0) {
    return ANY_TAG_HINT.test(argumentsStr)
  }

  for (const key of keys) {
    if (!VALID_KEY.test(key) || BAD_KEY_PATTERN.test(key)) {
      return true
    }
  }

  return false
}

/**
 * 修复损坏的 native tool_call arguments。
 *
 * 构造多个候选 XML 文本喂给 XmlToolScanner，取同名调用的最终 arguments。
 * 候选覆盖三种真实坏形态：
 *   1. arguments 本身是完整 `<invoke>` XML
 *   2. arguments 是裸 parameter 片段（拼外层 invoke）
 *   3. arguments 是 JSON 残骸，XML 片段藏在 value 里（从 parsed.values 捞拼）
 *
 * scanner 的 flush() 能兜底未闭合标签（真实模型经常吐 `<parameter>X` 不闭合）。
 *
 * @param toolName 模型下发的工具名（通常正确）
 * @param argumentsStr 原始 arguments 字符串
 * @param parsed 已 JSON.parse 的对象
 * @returns 修复后的 args；无法修复时返回原 parsed
 */
export function repairNativeArguments(
  toolName: string,
  argumentsStr: string,
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const candidates = buildRepairCandidates(toolName, argumentsStr, parsed)

  for (const rawCandidate of candidates) {
    // 预处理：补全未闭合的 <parameter> 标签（真实模型常吐残缺 XML），
    // 避免 scanner 把 </invoke> 等后续标签字符误吞进参数值。
    const candidate = closeUnclosedParameters(rawCandidate)
    const repaired = scanAndPick(candidate, toolName)
    if (repaired) {
      // scanner 返回的值都是字符串；对数字 / 布尔 / JSON 数组对象做轻量推断还原，
      // 对齐 parseXmlToolCalls 的行为（offset → number, edits → array 等）。
      return coerceJsonLikeValues(repaired)
    }
  }

  return parsed
}

/**
 * 从 assistant 正文里扫描 XML 工具调用，为参数缺失的 native tool_call 补全。
 *
 * 场景：部分模型在 native function calling 协议下，把工具名放进 tool_call.name，
 * 却把参数写在 assistant 正文 content（XML 或其他格式）而非 function.arguments。
 * 此时 toolCall.arguments 为空 / `{}`，工具报「缺少参数」。
 *
 * 本函数遍历一批 toolCalls，对参数为空的，用 parseXmlToolCalls 扫描正文，
 * 取同名调用的 arguments 补全。
 *
 * @param toolCalls 本轮所有工具调用（会被原地修改 arguments）
 * @param content assistant 正文（可能含 XML 工具调用）
 * @returns 被补全的 toolCallId 列表（用于诊断 / 日志）
 */
export function repairEmptyArgsFromContent(
  toolCalls: ChatToolCall[],
  content: string
): string[] {
  if (!content || toolCalls.length === 0) return []

  // 候选 1：XML 风格（parseXmlToolCalls 专精，含 MiniMax 占位符清理）
  const xmlParsed = parseXmlToolCalls(stripMinimaxArtifacts(content))
  // 候选 2：行内 JSON / fenced JSON / 其他伪工具调用格式（parseTextToolCalls 兜底）
  const textParsed = parseTextToolCalls(content)

  // 合并两个解析器的工具调用，按名查找补全
  const allParsedCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
    ...xmlParsed.toolCalls.map(c => ({ name: c.name, arguments: c.arguments })),
    ...(textParsed?.toolCalls ?? []).map(c => ({ name: c.toolName, arguments: c.arguments }))
  ]
  if (allParsedCalls.length === 0) return []

  const repaired: string[] = []
  for (const tc of toolCalls) {
    // 只补全参数为空的（空字符串 / 空 JSON / 空对象）
    if (!isEmptyArgs(tc.arguments)) continue

    // 严格按工具名匹配：把 A 工具的参数塞给 B 工具会引发误操作（如把 read 的
    // path 当成 bash 的 command 执行），绝不 fallback 取第一个。
    const match = allParsedCalls.find(c => c.name === tc.name)
    if (match && Object.keys(match.arguments).length > 0) {
      tc.arguments = JSON.stringify(match.arguments)
      repaired.push(tc.id)
    }
  }
  return repaired
}

/** 判断 arguments 字符串是否为空（空串 / `{}` / 非法 JSON） */
function isEmptyArgs(argumentsStr: string): boolean {
  const trimmed = argumentsStr.trim()
  if (trimmed === '' || trimmed === '{}') return true
  try {
    const obj = JSON.parse(trimmed)
    return typeof obj === 'object' && obj !== null && Object.keys(obj).length === 0
  } catch {
    return true
  }
}

/** 构造候选 XML 文本列表，覆盖各种坏形态 */
function buildRepairCandidates(
  toolName: string,
  argumentsStr: string,
  parsed: Record<string, unknown>
): string[] {
  // 候选优先级：从 JSON value 提取的 XML 片段最干净（不含 JSON 残骸），优先尝试；
  // 其次是 arguments 本身含完整 XML；最后才用「拼外层 invoke 包原始字符串」
  // （这条最容易把 JSON 的 } 等字符误吞进参数值，作为兜底）。
  const candidates: string[] = []

  // 候选 1（最高优先级）：JSON 残骸里 value 藏着 XML 片段
  const fragments = extractXmlFragments(parsed)
  if (fragments.length > 0) {
    const combined = fragments.join('\n')
    // combined 可能本身含完整 <invoke>，直接喂 scanner
    candidates.push(combined)
    // 也尝试拼外层 invoke（兼容 value 只是裸 parameter 的情况）
    candidates.push(`<invoke name="${toolName}">${combined}</invoke>`)
  }

  // 候选 2：arguments 本身就是完整 XML（含 <invoke> 或裸 <parameter>）
  if (INVOKE_HINT.test(argumentsStr) || PARAMETER_HINT.test(argumentsStr)) {
    candidates.push(argumentsStr)
    if (!INVOKE_HINT.test(argumentsStr)) {
      candidates.push(`<invoke name="${toolName}">${argumentsStr}</invoke>`)
    }
  }

  return candidates
}

/** 从 parsed 对象的所有 string value 里提取含 XML 标签的片段 */
function extractXmlFragments(parsed: Record<string, unknown>): string[] {
  const fragments: string[] = []
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && (PARAMETER_HINT.test(value) || INVOKE_HINT.test(value))) {
      fragments.push(value)
    }
  }
  return fragments
}

/** 用 XmlToolScanner 扫描候选文本，取同名调用的最终 arguments */
function scanAndPick(
  text: string,
  toolName: string
): Record<string, unknown> | null {
  const scanner = new XmlToolScanner()
  const toolArgs = new Map<string, { name: string; args: Record<string, unknown> }>()

  for (const ev of scanner.feed(text)) {
    collectScanEvent(ev, toolArgs)
  }
  for (const ev of scanner.flush()) {
    collectScanEvent(ev, toolArgs)
  }

  if (toolArgs.size === 0) return null

  // 优先同名
  for (const info of toolArgs.values()) {
    if (info.name === toolName && hasUsefulArgs(info.args)) {
      return info.args
    }
  }
  // 兜底：第一个有内容的
  for (const info of toolArgs.values()) {
    if (hasUsefulArgs(info.args)) {
      return info.args
    }
  }
  return null
}

/** 累积 scanner 事件的 toolEnd arguments */
function collectScanEvent(
  ev: XmlScanEvent,
  toolArgs: Map<string, { name: string; args: Record<string, unknown> }>
): void {
  if (ev.type === 'toolEnd') {
    toolArgs.set(ev.id, { name: ev.name, args: ev.arguments })
  }
}

/** 判断 args 是否含至少一个合法 key（避免取到空 args） */
function hasUsefulArgs(args: Record<string, unknown>): boolean {
  return Object.keys(args).some(k => VALID_KEY.test(k))
}

/**
 * 补全文本中未闭合的 <parameter> 标签。
 *
 * 真实模型（尤其国产 / 中转）在 native 协议下常吐出残缺 XML，例如：
 *   <invoke name="edit"><parameter name="filePath">index.html</invoke>
 *                                        ↑ 缺 </parameter>
 *
 * XmlToolScanner 在 IN_PARAM 状态下找不到 </parameter> 时，会把后续所有字符
 * （包括 </invoke>）都累积进参数值，导致 filePath 变成 "index.html</invoke>"。
 */
function closeUnclosedParameters(text: string): string {
  const anyTag = /<\/?(?:parameter|invoke)\b[^>]*>/gi

  // 收集所有相关标签的位置和类型
  interface TagMark { idx: number; len: number; isCloseParam: boolean; isOpenParam: boolean }
  const marks: TagMark[] = []
  let m: RegExpExecArray | null
  while ((m = anyTag.exec(text)) !== null) {
    const tag = m[0]
    marks.push({
      idx: m.index,
      len: tag.length,
      isCloseParam: /^<\s*\/\s*parameter/.test(tag),
      isOpenParam: /^<\s*parameter/.test(tag)
    })
  }

  // 从后往前扫描，记录需要插入 </parameter> 的位置
  const insertPositions: number[] = []
  let depth = 0
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i]
    if (mark.isCloseParam) {
      depth++
    } else if (mark.isOpenParam) {
      if (depth > 0) {
        depth--
      } else {
        // 这个 <parameter> 没有对应的 </parameter>：在下一个标签前插入闭合
        const insertAt = i + 1 < marks.length ? marks[i + 1].idx : text.length
        insertPositions.push(insertAt)
      }
    }
  }

  if (insertPositions.length === 0) return text

  // 去重并按位置升序插入
  insertPositions.sort((a, b) => a - b)
  const unique = insertPositions.filter((pos, i) => i === 0 || pos !== insertPositions[i - 1])
  let result = text
  for (let i = unique.length - 1; i >= 0; i--) {
    result = result.slice(0, unique[i]) + '</parameter>' + result.slice(unique[i])
  }
  return result
}

/**
 * 对 args 中的字符串值做轻量 JSON 推断。
 *
 * XmlToolScanner 把所有 parameter 值作为字符串累积；但工具 schema 里
 * offset 是 number、edits 是数组。本函数把「看起来像 JSON」的字符串还原成
 * 对应类型，与 parseXmlToolCalls 全量解析的行为对齐。
 *
 * 规则（与 xmlToolScanner.tryJsonParseIfLooksLikeJson 一致）：
 *   - 纯数字 → number（前导 0 除外，避免误吞文件名如 "0777"）
 *   - true / false → boolean
 *   - {...} / [...] → 尝试 JSON.parse，失败则保留字符串
 *   - 其余 → 原样字符串
 */
function coerceJsonLikeValues(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    result[key] = typeof value === 'string' ? coerceString(value) : value
  }
  return result
}

function coerceString(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // 纯整数 / 小数（排除前导 0，避免误吞 "0777"、"0x1f" 等）
  if (/^-?[1-9]\d*(\.\d+)?$/.test(trimmed) || /^-?0(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed)
    if (!Number.isNaN(num)) return num
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}
