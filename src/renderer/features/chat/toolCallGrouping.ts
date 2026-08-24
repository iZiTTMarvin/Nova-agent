/**
 * 消息流工具块分组：将相邻同族过程工具合并为 ToolCallGroup 渲染单元。
 *
 * 边界（与产品规格一致）：
 * - 仅同一条 assistant 消息内的 blocks / toolCalls 序列
 * - thinking / text / image / 提问卡 / 计划卡 / 子代理打断 tool 连续段
 * - 不可聚合工具单独输出，并切断 buffer
 * - 同族连续且 count >= 2 才输出 toolGroup
 */
import type { Mode } from '../../../shared/session/types'
import { shouldRenderToolBlock } from './renderingPolicy'
import { getToolGroupKind, getToolGroupTraceParts } from './toolTraceDisplay'
import type { ExtendedToolCall, RendererMessageBlock, RendererToolBlock } from '../../stores/types'

/** 可聚合的过程工具；同一族的相邻调用合并为一个摘要组。 */
export const AGGREGATABLE_TOOL_NAMES = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'write',
  'edit',
  'bash'
])

export type RenderUnit =
  | { kind: 'block'; block: RendererMessageBlock; index: number }
  | { kind: 'tool'; block: RendererToolBlock }
  | { kind: 'toolGroup'; toolName: string; blocks: RendererToolBlock[] }

export function isAggregatableTool(toolName: string): boolean {
  return AGGREGATABLE_TOOL_NAMES.has(toolName) && getToolGroupKind(toolName) !== null
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
  mode: Mode,
  getIndex: (offset: number) => number = offset => offset
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

  for (let offset = 0; offset < blocks.length; offset++) {
    const block = blocks[offset]
    const index = getIndex(offset)

    // 非 tool 块（thinking / text / image / 编排进度）一律打断 tool 连续段并按原序输出
    if (block.type !== 'tool') {
      flushBuffer()
      units.push({ kind: 'block', block, index })
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

    // 同族连续：工具族变化时先 flush 再入队
    if (
      buffer.length > 0 &&
      getToolGroupKind(buffer[buffer.length - 1].toolName) !== getToolGroupKind(block.toolName)
    ) {
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

    if (
      buffer.length > 0 &&
      getToolGroupKind(buffer[buffer.length - 1].toolName) !== getToolGroupKind(block.toolName)
    ) {
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

export interface ToolGroupSummaryParts {
  /** 折叠头动作 */
  prefix: string
  /** 折叠头数量与附加说明 */
  pill: string
  suffix: string
}

/**
 * 生成工具聚合行的摘要片段。
 */
export function getToolGroupSummaryParts(
  toolName: string,
  blocks: RendererToolBlock[]
): ToolGroupSummaryParts {
  const { action, target, suffix } = getToolGroupTraceParts(toolName, blocks)
  return { prefix: action, pill: target, suffix }
}

/** 纯文本摘要（测试与无障碍用） */
export function getToolGroupSummary(toolName: string, blocks: RendererToolBlock[]): string {
  const { prefix, pill, suffix } = getToolGroupSummaryParts(toolName, blocks)
  return [prefix, pill, suffix].filter(Boolean).join(' ')
}
