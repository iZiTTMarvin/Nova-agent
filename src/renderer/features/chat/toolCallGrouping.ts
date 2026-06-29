/**
 * 消息流工具块分组：将相邻同类只读工具合并为 ToolCallGroup 渲染单元。
 *
 * 边界（与产品规格一致）：
 * - 仅同一条 assistant 消息内的 blocks / toolCalls 序列
 * - thinking / text / image 打断 tool 连续段
 * - 不可聚合工具单独输出，并切断 buffer
 * - 同类连续且 count >= 2 才输出 toolGroup
 */
import type { Mode } from '../../../shared/session/types'
import { shouldRenderToolBlock } from './renderingPolicy'
import type { ExtendedToolCall, RendererMessageBlock, RendererToolBlock } from '../../stores/types'

/** 可聚合的只读探索类工具 */
export const AGGREGATABLE_TOOL_NAMES = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search'
])

export type RenderUnit =
  | { kind: 'block'; block: RendererMessageBlock; index: number }
  | { kind: 'tool'; block: RendererToolBlock }
  | { kind: 'toolGroup'; toolName: string; blocks: RendererToolBlock[] }

export function isAggregatableTool(toolName: string): boolean {
  return AGGREGATABLE_TOOL_NAMES.has(toolName)
}

function toToolBlock(tc: ExtendedToolCall): RendererToolBlock {
  return {
    type: 'tool',
    toolCallId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    status: tc.status,
    result: tc.result,
    ...(tc.argumentsRaw !== undefined ? { argumentsRaw: tc.argumentsRaw } : {})
  }
}

/**
 * 将 blocks 序列映射为渲染单元（MessageItem blocks 路径）。
 */
export function buildBlockRenderUnits(
  blocks: RendererMessageBlock[] | undefined,
  mode: Mode
): RenderUnit[] {
  if (!blocks || blocks.length === 0) {
    return []
  }

  const units: RenderUnit[] = []
  let buffer: RendererToolBlock[] = []

  const flushBuffer = (): void => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      units.push({ kind: 'tool', block: buffer[0] })
    } else {
      units.push({
        kind: 'toolGroup',
        toolName: buffer[0].toolName,
        blocks: buffer
      })
    }
    buffer = []
  }

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]

    if (block.type === 'thinking' || block.type === 'text' || block.type === 'image') {
      flushBuffer()
      units.push({ kind: 'block', block, index })
      continue
    }

    if (block.type !== 'tool') {
      continue
    }

    if (!shouldRenderToolBlock(mode, block.toolName)) {
      continue
    }

    if (!isAggregatableTool(block.toolName)) {
      flushBuffer()
      units.push({ kind: 'tool', block })
      continue
    }

    // 同类连续：工具名变化时先 flush 再入队
    if (buffer.length > 0 && buffer[buffer.length - 1].toolName !== block.toolName) {
      flushBuffer()
    }
    buffer.push(block)
  }

  flushBuffer()
  return units
}

/**
 * 将 toolCalls 序列映射为渲染单元（无 blocks 的旧路径）。
 * 相邻性规则与 blocks 路径一致：整个数组视为连续 tool 段（中间无 text/thinking）。
 */
export function buildToolCallRenderUnits(
  toolCalls: ExtendedToolCall[] | undefined,
  mode: Mode
): RenderUnit[] {
  if (!toolCalls || toolCalls.length === 0) {
    return []
  }

  const visibleBlocks = toolCalls
    .filter(tc => shouldRenderToolBlock(mode, tc.name))
    .map(toToolBlock)

  if (visibleBlocks.length === 0) {
    return []
  }

  const units: RenderUnit[] = []
  let buffer: RendererToolBlock[] = []

  const flushBuffer = (): void => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      units.push({ kind: 'tool', block: buffer[0] })
    } else {
      units.push({
        kind: 'toolGroup',
        toolName: buffer[0].toolName,
        blocks: buffer
      })
    }
    buffer = []
  }

  for (const block of visibleBlocks) {
    if (!isAggregatableTool(block.toolName)) {
      flushBuffer()
      units.push({ kind: 'tool', block })
      continue
    }

    if (buffer.length > 0 && buffer[buffer.length - 1].toolName !== block.toolName) {
      flushBuffer()
    }
    buffer.push(block)
  }

  flushBuffer()
  return units
}

/** 从路径参数提取文件名（用于聚合摘要 pill） */
export function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}

/** 截断展示文本 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + '...'
}

export interface ToolGroupSummaryParts {
  /** 折叠头前缀文案（不含 pill） */
  prefix: string
  /** pill 内展示的首项标识（路径/关键词等） */
  pill: string
  /** 折叠头后缀文案（「等 N 个文件」等） */
  suffix: string
}

/**
 * 生成工具聚合行的中文摘要片段（供 ToolCallGroup 渲染 pill）。
 */
export function getToolGroupSummaryParts(
  toolName: string,
  blocks: RendererToolBlock[]
): ToolGroupSummaryParts {
  const count = blocks.length
  const firstArgs = blocks[0]?.arguments ?? {}

  switch (toolName) {
    case 'read': {
      const path = (firstArgs.path as string) || ''
      const name = path ? basenameFromPath(path) : '文件'
      return {
        prefix: '读取',
        pill: name,
        suffix: count >= 2 ? `等 ${count} 个文件` : ''
      }
    }
    case 'grep': {
      const pattern = (firstArgs.pattern as string) || ''
      const pill = pattern ? truncate(pattern, 40) : '文本'
      return {
        prefix: '搜索',
        pill,
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    case 'find': {
      const pattern = (firstArgs.pattern as string) || ''
      const pill = pattern ? truncate(pattern, 40) : '文件'
      return {
        prefix: '定位',
        pill,
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    case 'ls': {
      const path = (firstArgs.path as string) || ''
      const name = path ? basenameFromPath(path) : '目录'
      return {
        prefix: '列出',
        pill: name,
        suffix: count >= 2 ? `等 ${count} 个目录` : ''
      }
    }
    case 'web_search': {
      const query = (firstArgs.query as string) || ''
      const pill = query ? truncate(query, 40) : '关键词'
      return {
        prefix: '搜索',
        pill,
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
    }
    default:
      return {
        prefix: '执行',
        pill: toolName,
        suffix: count >= 2 ? `等 ${count} 次` : ''
      }
  }
}

/** 纯文本摘要（测试与无障碍用） */
export function getToolGroupSummary(toolName: string, blocks: RendererToolBlock[]): string {
  const { prefix, pill, suffix } = getToolGroupSummaryParts(toolName, blocks)
  if (!suffix) return `${prefix} ${pill}`
  return `${prefix} ${pill} ${suffix}`
}
