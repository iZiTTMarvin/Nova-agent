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

/**
 * askQuestion 不参与「最后一个可见工具」边界判定：
 * 避免把 ask 当成过程终点，把后续结论文案卷进过程树。
 * ask 仍按 blocks 原序进入 process 或 answer。
 */
function isAskQuestionTool(toolName: string): boolean {
  return toolName === 'askQuestion'
}

/** 过程区时间线段：block 单元与 tool/toolGroup 单元按原始顺序穿插 */
export type ProcessSegment =
  | { kind: 'block'; block: RendererMessageBlock; index: number }
  | Extract<RenderUnit, { kind: 'tool' } | { kind: 'toolGroup' }>

export interface TurnRenderModel {
  phase: TurnPhase
  hasProcess: boolean
  durationMs?: number
  /** 恒为空；历史字段保留以免破坏解构 */
  bubbleUnits: RenderUnit[]
  processTimeline: ProcessSegment[]
  answerUnits: RenderUnit[]
}

function findLastVisibleToolIndex(blocks: RendererMessageBlock[], mode: Mode): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && shouldRenderToolBlock(mode, block.toolName) && !isAskQuestionTool(block.toolName)) {
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
 * 将过程区 blocks 映射为按时间线排序的 ProcessSegment[]（tool 段经 buildBlockRenderUnits 聚合）。
 */
export function buildProcessTimeline(
  blocks: RendererMessageBlock[],
  lastToolIndex: number,
  mode: Mode
): ProcessSegment[] {
  if (lastToolIndex < 0) return []

  const segments: ProcessSegment[] = []
  let toolRun: RendererToolBlock[] = []

  const flushToolRun = (): void => {
    if (toolRun.length === 0) return
    const units = buildBlockRenderUnits(toolRun, mode)
    for (const unit of units) {
      if (unit.kind === 'tool' || unit.kind === 'toolGroup') {
        segments.push(unit)
      }
    }
    toolRun = []
  }

  for (let i = 0; i <= lastToolIndex; i++) {
    const block = blocks[i]

    if (block.type === 'tool') {
      // askQuestion 不计入 lastToolIndex，但仍按时间线进入 process（若落在边界内）
      if (!shouldRenderToolBlock(mode, block.toolName)) {
        continue
      }
      toolRun.push(block)
      continue
    }

    flushToolRun()
    segments.push({ kind: 'block', block, index: i })
  }
  flushToolRun()

  return segments
}

function blocksToRenderUnits(blocks: RendererMessageBlock[], mode: Mode): RenderUnit[] {
  return buildBlockRenderUnits(blocks, mode)
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

  // ── blocks 路径（优先） ──
  if (blocks && blocks.length > 0) {
    const lastToolIndex = findLastVisibleToolIndex(blocks, mode)
    const hasProcess = lastToolIndex >= 0

    const answerBlocks: RendererMessageBlock[] = []

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!hasProcess) {
        answerBlocks.push(block)
        continue
      }
      if (i > lastToolIndex) {
        if (block.type === 'tool' && !shouldRenderToolBlock(mode, block.toolName)) {
          continue
        }
        answerBlocks.push(block)
      }
    }

    return {
      phase,
      hasProcess,
      durationMs,
      bubbleUnits: [],
      processTimeline: hasProcess ? buildProcessTimeline(blocks, lastToolIndex, mode) : [],
      answerUnits: blocksToRenderUnits(answerBlocks, mode)
    }
  }

  // ── 旧路径降级：toolCalls + content/thinking ──
  // askQuestion 不参与过程边界，但按调用顺序追加到 answer
  const processToolCalls =
    toolCalls?.filter(tc => shouldRenderToolBlock(mode, tc.name) && !isAskQuestionTool(tc.name)) ?? []
  const askToolCalls =
    toolCalls?.filter(tc => tc.name === 'askQuestion' && shouldRenderToolBlock(mode, tc.name)) ?? []
  const hasProcess = processToolCalls.length > 0
  const toolUnits = buildToolCallRenderUnits(processToolCalls, mode).filter(
    (u): u is Extract<RenderUnit, { kind: 'tool' } | { kind: 'toolGroup' }> =>
      u.kind === 'tool' || u.kind === 'toolGroup'
  )

  const processTimeline: ProcessSegment[] = hasProcess
    ? [
        ...(thinking?.trim()
          ? [{ kind: 'block' as const, block: { type: 'thinking' as const, content: thinking }, index: -1 }]
          : []),
        ...toolUnits
      ]
    : []

  const answerUnits: RenderUnit[] = []
  if (!hasProcess) {
    if (thinking?.trim()) {
      answerUnits.push({ kind: 'block', block: { type: 'thinking', content: thinking }, index: -1 })
    }
    if (content?.trim()) {
      answerUnits.push({ kind: 'block', block: { type: 'text', content }, index: -1 })
    }
  } else if (content?.trim()) {
    answerUnits.push({ kind: 'block', block: { type: 'text', content }, index: -1 })
  }
  answerUnits.push(...buildToolCallRenderUnits(askToolCalls, mode))

  return {
    phase,
    hasProcess,
    durationMs,
    bubbleUnits: [],
    processTimeline,
    answerUnits
  }
}
