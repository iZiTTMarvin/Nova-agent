/**
 * TurnProcessTree 纯函数层：分区、摘要、过程时间线。
 */
import type { Mode } from '../../../shared/session/types'
import { shouldRenderToolBlock } from './renderingPolicy'
import {
  buildBlockRenderUnits,
  buildToolCallRenderUnits,
  type RenderUnit
} from './toolCallGrouping'
import type {
  ExtendedToolCall,
  RendererMessageBlock,
  RendererToolBlock
} from '../../stores/types'

/** 回合阶段 */
export type TurnPhase = 'live' | 'completed'

/** block 单元与 tool/toolGroup 单元按原始顺序穿插。 */
export type ProcessSegment =
  | { kind: 'block'; block: RendererMessageBlock; index: number }
  | Extract<RenderUnit, { kind: 'tool' } | { kind: 'toolGroup' }>

export type TurnTimelineSegment = ProcessSegment & {
  display: 'process' | 'persistent'
}

export interface TurnRenderModel {
  phase: TurnPhase
  hasProcess: boolean
  durationMs?: number
  timeline: TurnTimelineSegment[]
  /** completed 且无最终 text：折叠区外需展示占位文案（仅渲染层，不写入 blocks） */
  missingAnswer: boolean
}

/**
 * 最终答案边界：turn 内最后一段非空 text，且其后没有任何可见工具。
 * thinking、工具、plan 卡、过程性 text 一律属于工作过程；只有这段 text 外露。
 */
function findAnswerIndex(blocks: RendererMessageBlock[], mode: Mode): number {
  let lastVisibleToolIndex = -1
  let lastTextIndex = -1
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type === 'tool') {
      if (shouldRenderToolBlock(mode, block.toolName)) lastVisibleToolIndex = i
      continue
    }
    if (block.type === 'text' && block.content.trim()) lastTextIndex = i
  }
  return lastTextIndex > lastVisibleToolIndex ? lastTextIndex : -1
}

/** 同一消息只投影最后一次成功/进行中的 save_plan；失败的 save_plan 不替换已有计划。 */
function findLastSavePlanIndex(blocks: RendererMessageBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && block.toolName === 'save_plan' && block.status !== 'error') {
      return i
    }
  }
  return -1
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

function transitionMarkdownFence(
  line: string,
  current: MarkdownFence | null
): { fence: MarkdownFence | null; delimiter: boolean } {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return { fence: current, delimiter: false }

  const marker = match[1][0] as '`' | '~'
  const length = match[1].length
  const suffix = match[2]

  if (current) {
    const closes =
      marker === current.marker &&
      length >= current.length &&
      /^[\t ]*$/.test(suffix)
    return closes
      ? { fence: null, delimiter: true }
      : { fence: current, delimiter: false }
  }

  // CommonMark 不允许反引号围栏的 info string 再包含反引号。
  if (marker === '`' && suffix.includes('`')) {
    return { fence: null, delimiter: false }
  }
  return { fence: { marker, length }, delimiter: true }
}

/**
 * 将 provider reasoning 转成可交给 MarkdownRenderer 的展示文本。
 *
 * reasoning 原文仍由 runtime/session 完整保存；这里只修复展示协议。部分模型会把多个
 * 加粗摘要项无空白相邻输出为 `**A****B**`，CommonMark 会将中间星号视为普通字符。
 * 仅在普通 Markdown 文本中识别该边界；围栏代码和行内代码保持字节不变。
 */
export function normalizeThinkingForDisplay(thinking: string): string {
  if (!thinking.includes('****')) return thinking

  let fence: MarkdownFence | null = null
  let inlineCodeTicks = 0

  return thinking
    .split(/(\r?\n)/)
    .map(part => {
      if (part === '\n' || part === '\r\n') return part

      const transition = transitionMarkdownFence(part, fence)
      if (transition.delimiter) {
        fence = transition.fence
        inlineCodeTicks = 0
        return part
      }
      if (fence !== null) return part

      let result = ''
      let strongOpen = false
      for (let i = 0; i < part.length;) {
        if (part[i] === '`') {
          let runLength = 1
          while (part[i + runLength] === '`') runLength += 1
          if (inlineCodeTicks === 0) inlineCodeTicks = runLength
          else if (inlineCodeTicks === runLength) inlineCodeTicks = 0
          result += part.slice(i, i + runLength)
          i += runLength
          continue
        }

        if (
          inlineCodeTicks === 0 &&
          strongOpen &&
          part.startsWith('****', i) &&
          i > 0 &&
          i + 4 < part.length &&
          !/\s/.test(part[i - 1]) &&
          !/\s/.test(part[i + 4])
        ) {
          result += '**\n\n**'
          i += 4
          continue
        }

        if (
          inlineCodeTicks === 0 &&
          part.startsWith('**', i) &&
          part[i - 1] !== '*' &&
          part[i + 2] !== '*'
        ) {
          const previous = part[i - 1]
          const next = part[i + 2]
          if (!strongOpen && next !== undefined && !/\s/.test(next)) {
            strongOpen = true
          } else if (
            strongOpen &&
            previous !== undefined &&
            !/\s/.test(previous)
          ) {
            strongOpen = false
          }
          result += '**'
          i += 2
          continue
        }

        result += part[i]
        i += 1
      }
      return result
    })
    .join('')
}

/**
 * 将 blocks 映射为按时间线排序的 TurnTimelineSegment[]（tool 段经 buildBlockRenderUnits 聚合）。
 * 工具全部属于 process；只有 answerIndex 处的 text 是 persistent；空 text 不产生渲染单元。
 */
function buildTimeline(blocks: RendererMessageBlock[], mode: Mode): TurnTimelineSegment[] {
  const answerIndex = findAnswerIndex(blocks, mode)
  const lastSavePlanIndex = findLastSavePlanIndex(blocks)
  const timeline: TurnTimelineSegment[] = []
  let toolRun: RendererToolBlock[] = []

  const flushToolRun = (): void => {
    if (toolRun.length === 0) return
    const units = buildBlockRenderUnits(toolRun, mode)
    for (const unit of units) {
      if (unit.kind === 'tool' || unit.kind === 'toolGroup') {
        timeline.push({ ...unit, display: 'process' })
      }
    }
    toolRun = []
  }

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]

    if (block.type === 'tool') {
      if (!shouldRenderToolBlock(mode, block.toolName)) continue
      if (block.toolName === 'save_plan' && index !== lastSavePlanIndex) continue
      toolRun.push(block)
      continue
    }

    if (block.type === 'text' && !block.content.trim()) continue

    flushToolRun()
    timeline.push({
      kind: 'block',
      block,
      index,
      display: index === answerIndex ? 'persistent' : 'process'
    })
  }
  flushToolRun()
  return timeline
}

function resolveDurationMs(
  phase: TurnPhase,
  turnStartedAt?: number,
  turnEndedAt?: number
): number | undefined {
  if (turnStartedAt === undefined) return undefined
  if (phase === 'live') return Date.now() - turnStartedAt
  if (turnEndedAt !== undefined) return turnEndedAt - turnStartedAt
  return undefined
}

export function resolveTurnPhase(
  messageId: string,
  currentGeneratingMessageId: string | null,
  isGenerating: boolean
): TurnPhase {
  if (isGenerating && messageId === currentGeneratingMessageId) return 'live'
  return 'completed'
}

export function buildTurnRenderModel(input: {
  blocks: RendererMessageBlock[] | undefined
  toolCalls: ExtendedToolCall[] | undefined
  mode: Mode
  phase: TurnPhase
  turnStartedAt?: number
  turnEndedAt?: number
  /** 旧路径：无 blocks 时的 thinking 字符串 */
  thinking?: string
  /** 旧路径：无 blocks 时的 content 字符串 */
  content?: string
}): TurnRenderModel {
  const {
    blocks,
    toolCalls,
    mode,
    phase,
    turnStartedAt,
    turnEndedAt,
    thinking,
    content
  } = input

  const durationMs = resolveDurationMs(phase, turnStartedAt, turnEndedAt)
  let timeline: TurnTimelineSegment[]

  if (blocks && blocks.length > 0) {
    timeline = buildTimeline(blocks, mode)
  } else {
    // 旧路径降级：toolCalls + content/thinking。语义与 blocks 路径一致：
    // thinking 与全部工具（含 askQuestion）属于过程，content 是最终答案。
    const thinkingBlock: RendererMessageBlock | null = thinking?.trim()
      ? { type: 'thinking', content: thinking }
      : null
    const answerBlock: RendererMessageBlock | null = content?.trim()
      ? { type: 'text', content }
      : null
    timeline = [
      ...(thinkingBlock
        ? [{ kind: 'block' as const, block: thinkingBlock, index: -1, display: 'process' as const }]
        : []),
      ...buildToolCallRenderUnits(toolCalls, mode)
        .filter((unit): unit is Extract<RenderUnit, { kind: 'tool' } | { kind: 'toolGroup' }> =>
          unit.kind === 'tool' || unit.kind === 'toolGroup')
        .map(unit => ({ ...unit, display: 'process' as const })),
      ...(answerBlock
        ? [{ kind: 'block' as const, block: answerBlock, index: -1, display: 'persistent' as const }]
        : [])
    ]
  }

  const hasProcess = timeline.some(segment => segment.display === 'process')
  const hasAnswer = timeline.some(segment => segment.display === 'persistent')

  return {
    phase,
    hasProcess,
    durationMs,
    timeline,
    missingAnswer: phase === 'completed' && hasProcess && !hasAnswer
  }
}
