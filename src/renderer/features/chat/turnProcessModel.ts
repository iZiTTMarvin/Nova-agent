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
 *
 * cache 命中时按 block 引用前缀复用已产出的段：流式 tick 只浅拷贝尾部，
 * 前缀段（含 toolGroup 的 blocks 数组）引用保持稳定，下游 React.memo 不再级联失效。
 */
function buildTimeline(
  blocks: RendererMessageBlock[],
  mode: Mode,
  cache?: TurnBuildCache
): TurnTimelineSegment[] {
  const answerIndex = findAnswerIndex(blocks, mode)
  const lastSavePlanIndex = findLastSavePlanIndex(blocks)

  const reused = reuseTimelinePrefix(blocks, mode, answerIndex, lastSavePlanIndex, cache)

  const timeline: TurnTimelineSegment[] = reused.timeline
  const segmentEndBlockIndex: number[] = reused.segmentEndBlockIndex
  let toolRun: RendererToolBlock[] = []
  let runLastBlockIndex = -1

  const flushToolRun = (): void => {
    if (toolRun.length === 0) return
    const units = buildBlockRenderUnits(toolRun, mode)
    for (const unit of units) {
      if (unit.kind === 'tool' || unit.kind === 'toolGroup') {
        timeline.push({ ...unit, display: 'process' })
        segmentEndBlockIndex.push(runLastBlockIndex)
      }
    }
    toolRun = []
  }

  for (let index = reused.resumeBlockIndex; index < blocks.length; index++) {
    const block = blocks[index]

    if (block.type === 'tool') {
      if (!shouldRenderToolBlock(mode, block.toolName)) continue
      if (block.toolName === 'save_plan' && index !== lastSavePlanIndex) continue
      toolRun.push(block)
      runLastBlockIndex = index
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
    segmentEndBlockIndex.push(index)
  }
  flushToolRun()

  if (cache) {
    cache.blocks = blocks
    cache.mode = mode
    cache.answerIndex = answerIndex
    cache.lastSavePlanIndex = lastSavePlanIndex
    cache.timeline = timeline
    cache.segmentEndBlockIndex = segmentEndBlockIndex
  }
  return timeline
}

/**
 * 计算可复用的 timeline 前缀。
 * 段可复用当且仅当：其输入 block 引用全部未变（位于公共引用前缀内）、
 * 且不接触上次构建的尾部（尾部 toolRun 会吞并新同族块、末块内容会继续增长）、
 * 且 answer / save_plan 的可见性判定未发生影响前缀的变化。
 * 任一条件不满足即整体全量重建（与无 cache 行为一致，仅损失性能不损失正确性）。
 */
function reuseTimelinePrefix(
  blocks: RendererMessageBlock[],
  mode: Mode,
  answerIndex: number,
  lastSavePlanIndex: number,
  cache?: TurnBuildCache
): { timeline: TurnTimelineSegment[]; segmentEndBlockIndex: number[]; resumeBlockIndex: number } {
  if (!cache || cache.mode !== mode || cache.timeline.length === 0) {
    return { timeline: [], segmentEndBlockIndex: [], resumeBlockIndex: 0 }
  }

  const oldBlocks = cache.blocks
  // 公共引用前缀：第一个引用不同的位置
  let shared = 0
  const limit = Math.min(oldBlocks.length, blocks.length)
  while (shared < limit && oldBlocks[shared] === blocks[shared]) shared++

  let reuseCount = 0
  while (
    reuseCount < cache.timeline.length - 1 &&
    cache.segmentEndBlockIndex[reuseCount] < shared &&
    cache.segmentEndBlockIndex[reuseCount] < oldBlocks.length - 1
  ) {
    reuseCount++
  }

  const reusedEnd = reuseCount > 0 ? cache.segmentEndBlockIndex[reuseCount - 1] : -1

  // answer 可见性：复用前缀内的 persistent 段资格只可能被尾部变化剥夺；
  // 前缀内新获得/失去 persistent 资格都要求该段 display 变化 → 放弃复用
  const oldAnswer = cache.answerIndex
  const answerSafe =
    oldAnswer === answerIndex ||
    (oldAnswer === -1 && answerIndex >= shared) ||
    (oldAnswer >= oldBlocks.length - 1 && answerIndex >= shared && oldAnswer > reusedEnd)
  // save_plan 只保留最后一个：判定变化时，无论旧 index 还是新 index 落在
  // 复用前缀内，该前缀段的可见性都会翻转 → 放弃复用
  const oldSavePlan = cache.lastSavePlanIndex
  const savePlanSafe = !(
    oldSavePlan !== lastSavePlanIndex &&
    (oldSavePlan <= reusedEnd || lastSavePlanIndex <= reusedEnd)
  )

  if (reuseCount === 0 || !answerSafe || !savePlanSafe) {
    return { timeline: [], segmentEndBlockIndex: [], resumeBlockIndex: 0 }
  }

  return {
    timeline: cache.timeline.slice(0, reuseCount),
    segmentEndBlockIndex: cache.segmentEndBlockIndex.slice(0, reuseCount),
    resumeBlockIndex: reusedEnd + 1
  }
}

/** 段输出由其输入 block 引用完全决定；流式 tick 只改尾部，前缀段可跨构建复用 */
export interface TurnBuildCache {
  blocks: RendererMessageBlock[]
  mode: Mode
  answerIndex: number
  lastSavePlanIndex: number
  timeline: TurnTimelineSegment[]
  /** 每个段输入的最后一个 block 下标（与 timeline 一一对应） */
  segmentEndBlockIndex: number[]
}

function resolveDurationMs(
  phase: TurnPhase,
  turnStartedAt?: number,
  turnEndedAt?: number
): number | undefined {
  // 折叠头只在轮次结束后渲染，live 期间不携带时长——否则每帧流式 tick
  // 都要为此重建整个 turnModel
  if (phase === 'live' || turnStartedAt === undefined) return undefined
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

export function buildTurnRenderModel(
  input: {
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
    /** blocks 路径的增量构建缓存；同一消息实例内跨调用复用（见 MessageItem） */
    cache?: TurnBuildCache
  }
): TurnRenderModel {
  const {
    blocks,
    toolCalls,
    mode,
    phase,
    turnStartedAt,
    turnEndedAt,
    thinking,
    content,
    cache
  } = input

  const durationMs = resolveDurationMs(phase, turnStartedAt, turnEndedAt)
  let timeline: TurnTimelineSegment[]

  if (blocks && blocks.length > 0) {
    timeline = buildTimeline(blocks, mode, cache)
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
