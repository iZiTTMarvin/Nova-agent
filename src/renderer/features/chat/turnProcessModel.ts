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
  MessageDiffCache,
  RendererMessageBlock,
  RendererToolBlock
} from '../../stores/types'
import type { DiffHunk } from '../../../shared/diff/types'

/** 回合阶段 */
export type TurnPhase = 'live' | 'completed'

/**
 * 结论区尾部工具：不进过程树，去重后追加到 answerUnits 末尾。
 * 与结论文案同区展示，避免顶置冒泡造成「卡片在上、说明在下」。
 */
const ANSWER_TAIL_TOOL_NAMES = new Set(['askQuestion'])

export interface TurnSummary {
  editedFileCount: number
  exploredFileCount: number
  searchCount: number
  commandCount: number
  additions: number | null
  deletions: number | null
  diffStatsReady: boolean
  thoughtPreview?: string
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
  summary: TurnSummary
}

function isAnswerTailTool(toolName: string): boolean {
  return ANSWER_TAIL_TOOL_NAMES.has(toolName)
}

/**
 * 结论区尾部 askQuestion：仅保留最后一次，不堆叠历史。
 */
export function prepareAnswerAskBlocks(
  blocks: RendererMessageBlock[],
  mode: Mode
): RendererMessageBlock[] {
  let lastAsk: RendererToolBlock | undefined

  for (const block of blocks) {
    if (block.type !== 'tool') continue
    if (block.toolName !== 'askQuestion') continue
    if (!shouldRenderToolBlock(mode, block.toolName)) continue
    lastAsk = block
  }

  return lastAsk ? [lastAsk] : []
}

/** 旧路径 toolCalls：与 prepareAnswerAskBlocks 同一套去重 */
function prepareAnswerAskToolCalls(
  toolCalls: ExtendedToolCall[] | undefined,
  mode: Mode
): ExtendedToolCall[] {
  if (!toolCalls?.length) return []

  let lastAsk: ExtendedToolCall | undefined

  for (const tc of toolCalls) {
    if (tc.name !== 'askQuestion') continue
    if (!shouldRenderToolBlock(mode, tc.name)) continue
    lastAsk = tc
  }

  return lastAsk ? [lastAsk] : []
}

function extractPath(args: Record<string, unknown>): string | undefined {
  const raw = args.path ?? args.filePath ?? args.directory ?? args.file
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/**
 * 按 unified diff content 统计真实增删行（+/- 前缀行），不含上下文空格行。
 * hunk.newLines / hunk.oldLines 是 hunk 头跨度，含 CONTEXT 上下文，不能直接当增删计数。
 */
export function countHunkLineChanges(hunk: DiffHunk): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  if (!hunk.content) return { additions, deletions }
  for (const line of hunk.content.split('\n')) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function computeDiffStats(diffCache?: MessageDiffCache): Pick<TurnSummary, 'additions' | 'deletions' | 'diffStatsReady'> {
  if (!diffCache?.diffs?.length) {
    return { additions: null, deletions: null, diffStatsReady: false }
  }

  let additions = 0
  let deletions = 0
  for (const diff of diffCache.diffs) {
    for (const hunk of diff.hunks) {
      const delta = countHunkLineChanges(hunk)
      additions += delta.additions
      deletions += delta.deletions
    }
  }
  return { additions, deletions, diffStatsReady: true }
}

function collectToolSummaryFromBlocks(
  blocks: RendererMessageBlock[],
  mode: Mode
): Pick<TurnSummary, 'editedFileCount' | 'exploredFileCount' | 'searchCount' | 'commandCount'> {
  const editedPaths = new Set<string>()
  const exploredPaths = new Set<string>()
  let searchCount = 0
  let commandCount = 0

  for (const block of blocks) {
    if (block.type !== 'tool') continue
    if (!shouldRenderToolBlock(mode, block.toolName)) continue
    if (isAnswerTailTool(block.toolName)) continue

    const args = block.arguments ?? {}
    const path = extractPath(args)

    if (block.toolName === 'write' || block.toolName === 'edit') {
      if (path) editedPaths.add(path)
    } else if (block.toolName === 'read' || block.toolName === 'ls' || block.toolName === 'find') {
      if (path) exploredPaths.add(path)
      else if (block.toolName === 'ls' || block.toolName === 'find') {
        exploredPaths.add(`__${block.toolName}__${block.toolCallId}`)
      }
    } else if (block.toolName === 'grep' || block.toolName === 'web_search') {
      searchCount += 1
    } else if (block.toolName === 'bash') {
      commandCount += 1
    }
  }

  return {
    editedFileCount: editedPaths.size,
    exploredFileCount: exploredPaths.size,
    searchCount,
    commandCount
  }
}

function collectToolSummaryFromToolCalls(
  toolCalls: ExtendedToolCall[],
  mode: Mode
): Pick<TurnSummary, 'editedFileCount' | 'exploredFileCount' | 'searchCount' | 'commandCount'> {
  const blocks: RendererMessageBlock[] = toolCalls.map(tc => ({
    type: 'tool',
    toolCallId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    status: tc.status,
    result: tc.result
  }))
  return collectToolSummaryFromBlocks(blocks, mode)
}

function findLastVisibleToolIndex(blocks: RendererMessageBlock[], mode: Mode): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && shouldRenderToolBlock(mode, block.toolName) && !isAnswerTailTool(block.toolName)) {
      return i
    }
  }
  return -1
}

function buildThoughtPreview(processBlocks: RendererMessageBlock[]): string | undefined {
  for (const block of processBlocks) {
    if (block.type === 'thinking') {
      const trimmed = block.content.trim()
      if (trimmed) return trimmed.slice(0, 120)
    }
  }

  let lastShortText: string | undefined
  for (const block of processBlocks) {
    if (block.type === 'text') {
      const trimmed = block.content.trim()
      if (trimmed.length > 0 && trimmed.length <= 200) {
        lastShortText = trimmed
      }
    }
  }
  return lastShortText?.slice(0, 120)
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
      if (!shouldRenderToolBlock(mode, block.toolName) || isAnswerTailTool(block.toolName)) {
        continue
      }
      toolRun.push(block)
      continue
    }

    flushToolRun()
    if (block.type === 'thinking' || block.type === 'text' || block.type === 'image') {
      segments.push({ kind: 'block', block, index: i })
    }
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
  diffCache?: MessageDiffCache
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
    diffCache,
    thinking,
    content
  } = input

  const durationMs = resolveDurationMs(phase, turnStartedAt, turnEndedAt)
  const diffPart = computeDiffStats(diffCache)

  // ── blocks 路径（优先） ──
  if (blocks && blocks.length > 0) {
    const lastToolIndex = findLastVisibleToolIndex(blocks, mode)
    const hasProcess = lastToolIndex >= 0

    const answerBlocks: RendererMessageBlock[] = []
    const processBlocksForSummary: RendererMessageBlock[] = []

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      // askQuestion 不进 process/answer 主列表，最后追加到 answer 末尾
      if (block.type === 'tool' && isAnswerTailTool(block.toolName) && shouldRenderToolBlock(mode, block.toolName)) {
        continue
      }
      if (!hasProcess) {
        answerBlocks.push(block)
        continue
      }
      if (i <= lastToolIndex) {
        if (block.type !== 'tool' || (shouldRenderToolBlock(mode, block.toolName) && !isAnswerTailTool(block.toolName))) {
          processBlocksForSummary.push(block)
        }
      } else {
        // 结论区不收纳模式隐藏的 tool（如 plan 下 write），避免无效 block 进入 answerUnits
        if (block.type === 'tool' && !shouldRenderToolBlock(mode, block.toolName)) {
          continue
        }
        answerBlocks.push(block)
      }
    }

    const toolSummary = collectToolSummaryFromBlocks(processBlocksForSummary, mode)
    const thoughtPreview = buildThoughtPreview(processBlocksForSummary)
    const askTailUnits = blocksToRenderUnits(prepareAnswerAskBlocks(blocks, mode), mode)

    return {
      phase,
      hasProcess,
      durationMs,
      bubbleUnits: [],
      processTimeline: hasProcess ? buildProcessTimeline(blocks, lastToolIndex, mode) : [],
      answerUnits: [...blocksToRenderUnits(answerBlocks, mode), ...askTailUnits],
      summary: {
        ...toolSummary,
        ...diffPart,
        thoughtPreview
      }
    }
  }

  // ── 旧路径降级：toolCalls + content/thinking ──
  const visibleToolCalls = toolCalls?.filter(tc => shouldRenderToolBlock(mode, tc.name) && !isAnswerTailTool(tc.name)) ?? []
  const hasProcess = visibleToolCalls.length > 0
  const toolUnits = buildToolCallRenderUnits(visibleToolCalls, mode).filter(
    (u): u is Extract<RenderUnit, { kind: 'tool' } | { kind: 'toolGroup' }> =>
      u.kind === 'tool' || u.kind === 'toolGroup'
  )

  const legacyProcessBlocks: RendererMessageBlock[] = []
  if (hasProcess && thinking?.trim()) {
    legacyProcessBlocks.push({ type: 'thinking', content: thinking })
  }

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

  const askTailUnits = buildToolCallRenderUnits(prepareAnswerAskToolCalls(toolCalls, mode), mode)
  answerUnits.push(...askTailUnits)

  const toolSummary = hasProcess
    ? collectToolSummaryFromToolCalls(visibleToolCalls, mode)
    : { editedFileCount: 0, exploredFileCount: 0, searchCount: 0, commandCount: 0 }
  const thoughtPreview = buildThoughtPreview(legacyProcessBlocks)

  return {
    phase,
    hasProcess,
    durationMs,
    bubbleUnits: [],
    processTimeline,
    answerUnits,
    summary: {
      ...toolSummary,
      ...diffPart,
      thoughtPreview
    }
  }
}
