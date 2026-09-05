import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MessageBlock } from '../../../src/shared/session'
import type { ChatMessage } from '../../../src/runtime/model/types'
import {
  buildConversationContext,
  SessionStore,
  type CompactionLedger
} from '../../../src/runtime/sessions'
import { restoreFromLedger, persistCompactionSnapshot } from '../../../src/runtime/sessions/contextSnapshot'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import {
  createRequestProjectionArchiveCache,
  projectRequestMessages,
  type RequestProjectionArchiveCache,
  type RequestProjectionInput
} from '../../../src/runtime/request-projection'
import { ArtifactStore } from '../../../src/runtime/artifacts/ArtifactStore'
import { historyReadTool } from '../../../src/runtime/tools/historyRead'
import { createReadState } from '../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../src/runtime/tools/types'

interface CompactionEvalMetrics {
  evidenceKind: 'synthetic-structure-only'
  snapshot: {
    scenarios: Array<{
      name: string
      baselineBytes: number
      ledgerBytes: number
      reductionPercent: number
    }>
    minimumReductionPercent: number
    maximumReductionPercent: number
  }
  midTurnRestore: {
    baselineRequestBytes: number
    ledgerRequestBytes: number
    reductionPercent: number
    baselineDuplicateToolCallIds: number
    ledgerDuplicateToolCallIds: number
    duplicateToolCallReductionPercent: number
  }
  prefixStability: {
    baselineReusablePrefixPercent: number
    ledgerReusablePrefixPercent: number
    improvementPercentagePoints: number
    estimatedTokensSavedPerProjectedRequest: number
  }
  projectionSafety: {
    singleLineOriginalRequestBytes: number
    singleLineProjectedRequestBytes: number
    singleLineReductionPercent: number
    multilineOriginalRequestBytes: number
    multilineProjectedRequestBytes: number
    multilineReductionPercent: number
    nonInflating: boolean
  }
  foldedHistoryRecall: {
    baselinePercent: null
    literalReadPercent: number
    queries: number
    improvementPercentagePoints: null
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function requestStats(messages: readonly ChatMessage[]): {
  bytes: number
  duplicateToolCallIds: number
} {
  const wireMessages = messages.map(
    ({ origin: _origin, internal: _internal, ...message }) => message
  )
  const toolCallIds = messages.flatMap(
    message => message.toolCalls?.map(call => call.id) ?? []
  )
  return {
    bytes: serializedBytes(wireMessages),
    duplicateToolCallIds: toolCallIds.length - new Set(toolCallIds).size
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}

function commonPrefixPercent(left: string, right: string): number {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  const comparable = Math.min(leftBytes.length, rightBytes.length)
  let shared = 0
  while (shared < comparable && leftBytes[shared] === rightBytes[shared]) shared++
  return comparable === 0 ? 100 : roundPercent(shared / comparable * 100)
}

function makeLedger(overrides: Partial<CompactionLedger> = {}): CompactionLedger {
  return {
    version: 2,
    entries: [
      {
        id: 'c1',
        shadows: {
          from: { messageId: 'u1', step: 0 },
          to: { messageId: 'a1', step: 0 }
        },
        stub: '读取了首个文件并确认旧实现的状态边界。\n[c1: 原文可用 history_read("c1")]',
        touchedFiles: { paths: ['src/runtime/example.ts'], omittedCount: 0 },
        trigger: 'mid-turn',
        createdAt: 1
      }
    ],
    state: {
      text: '## 目标\n完成上下文压缩重构\n\n## 下一步\n验证恢复和缓存前缀\n\n## 关键上下文\n档案保留原文\n\n## 进展\n账本已提交\n\n## 关键决策\n恢复只读取档案与坐标',
      coversThrough: { messageId: 'a1', step: 0 },
      taskVerbatim: null,
      realityLine: '工作区: D:/workspace',
      revision: 1
    },
    tailFrom: { messageId: 'a1', step: 1 },
    updatedAt: 1,
    ...overrides
  }
}

async function projectForEval(
  messages: ChatMessage[],
  archiveCache: RequestProjectionArchiveCache
) {
  const input: RequestProjectionInput = {
    messages,
    policy: { enabled: true },
    archiveCache,
    archive: async candidate => ({
      artifactId: `sha256-${candidate.bodySha256}`
    })
  }
  return projectRequestMessages(input)
}

describe('账本式交接压缩确定性 A/B 评估', () => {
  it('量化快照、轮内恢复、前缀稳定性与折叠历史回读', async () => {
    // 防止 SessionIndexHost 模块级连接缓存跨测试文件泄漏
    resetSessionIndexHostForTests()
    const tempDir = mkdtempSync(join(tmpdir(), 'nova-compaction-eval-'))
    try {
      const snapshotScenarios = [
        { name: 'small', messageCount: 4, charsPerMessage: 1_024 },
        { name: 'medium', messageCount: 12, charsPerMessage: 4_096 },
        { name: 'large', messageCount: 24, charsPerMessage: 8_192 }
      ].map(scenario => {
        const retainedTail: ChatMessage[] = Array.from(
          { length: scenario.messageCount },
          (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `tail-${index}-${'x'.repeat(scenario.charsPerMessage)}`
          })
        )
        const legacySnapshot = {
          version: 1,
          summary: makeLedger().state?.text ?? '',
          recentMessages: retainedTail,
          lastMessageId: 'u1',
          compactionLevel: 1,
          updatedAt: 1
        }
        const baselineBytes = serializedBytes(legacySnapshot)
        const ledgerBytes = serializedBytes(makeLedger())
        return {
          name: scenario.name,
          baselineBytes,
          ledgerBytes,
          reductionPercent: roundPercent((1 - ledgerBytes / baselineBytes) * 100)
        }
      })
      const ledger = makeLedger()

      const store = new SessionStore(tempDir)
      const session = store.create(tempDir, 'default')
      store.appendMessage(session.id, {
        id: 'u1',
        role: 'user',
        content: '依次读取两个文件并给出结论',
        timestamp: 1
      })
      const blocks: MessageBlock[] = [
        {
          type: 'tool',
          toolCallId: 'tc_a',
          toolName: 'read',
          arguments: { path: 'a.ts' },
          status: 'success',
          result: `a.ts\n${'A'.repeat(4096)}`
        },
        { type: 'thinking', content: '继续读取 b.ts' },
        {
          type: 'tool',
          toolCallId: 'tc_b',
          toolName: 'read',
          arguments: { path: 'b.ts' },
          status: 'success',
          result: `b.ts\n${'B'.repeat(4096)}`
        },
        { type: 'text', content: '两个文件均已读取。' }
      ]
      store.appendMessage(session.id, {
        id: 'a1',
        role: 'assistant',
        content: '两个文件均已读取。',
        blocks,
        toolCalls: [
          { id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}', result: `a.ts\n${'A'.repeat(4096)}` },
          { id: 'tc_b', name: 'read', arguments: '{"path":"b.ts"}', result: `b.ts\n${'B'.repeat(4096)}` }
        ],
        timestamp: 2
      })
      const archivedSession = store.load(session.id)!
      const archivedTurn = buildConversationContext(archivedSession, archivedSession.mode)
        .filter(message => message.origin?.messageId === 'a1')
      const snapshotTail = archivedTurn.filter(message => message.origin?.step === 0)
      const legacyRestored: ChatMessage[] = [
        { role: 'system', content: `你是助手。\n\n${ledger.state?.text ?? ''}` },
        ...snapshotTail,
        ...archivedTurn
      ]
      const restored = restoreFromLedger(archivedSession, ledger, '你是助手。')
      expect(restored.kind).toBe('restored')
      const projectionCache = createRequestProjectionArchiveCache()

      const hugeHistoricalResult = Array.from(
        { length: 300 },
        (_, index) => `${index + 1}: ${'Z'.repeat(80)}`
      ).join('\n')
      const stableHistory: ChatMessage[] = [
        { role: 'system', content: '稳定 system' },
        { role: 'user', content: '读取大文件' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'tc_huge', name: 'read', arguments: '{"path":"huge.log"}' }]
        },
        { role: 'tool', content: hugeHistoricalResult, toolCallId: 'tc_huge' },
        { role: 'assistant', content: '读取完成' }
      ]
      const previousRoundEnd = await projectForEval(stableHistory, projectionCache)
      const nextRoundMessages = [...stableHistory, { role: 'user' as const, content: '继续分析' }]
      const nextRoundCurrent = await projectForEval(nextRoundMessages, projectionCache)
      const projectedSharedPrefix = JSON.stringify(previousRoundEnd.messages)
      const currentSharedPrefix = JSON.stringify(nextRoundCurrent.messages.slice(0, stableHistory.length))
      const legacyRoundZeroPrefix = JSON.stringify(stableHistory)
      const baselinePrefixPercent = commonPrefixPercent(projectedSharedPrefix, legacyRoundZeroPrefix)
      const ledgerPrefixPercent = commonPrefixPercent(projectedSharedPrefix, currentSharedPrefix)
      const singleLineHistory: ChatMessage[] = stableHistory.map(message =>
        message.role === 'tool'
          ? { ...message, content: 'Z'.repeat(18 * 1024) }
          : message
      )
      const singleLineProjection = await projectForEval(
        singleLineHistory,
        createRequestProjectionArchiveCache()
      )

      const recallSession = store.create(tempDir, 'default')
      const foldedFacts = ['FROZEN_ALPHA_17', 'FROZEN_BETA_29', 'FROZEN_GAMMA_43']
      store.appendMessage(recallSession.id, {
        id: 'u-facts',
        role: 'user',
        content: foldedFacts.map((value, index) => `任务约束 ${index + 1}: ${value}`).join('\n'),
        timestamp: 1
      })
      store.appendMessage(recallSession.id, {
        id: 'a-facts',
        role: 'assistant',
        content: '已记录这些事实',
        timestamp: 2
      })
      store.appendMessage(recallSession.id, {
        id: 'u-tail',
        role: 'user',
        content: '继续当前任务',
        timestamp: 3
      })
      const recallLedger = makeLedger({
        entries: [
          {
            id: 'c1',
            shadows: {
              from: { messageId: 'u-facts', step: 0 },
              to: { messageId: 'a-facts', step: 0 }
            },
            stub: '已折叠三条事实',
            touchedFiles: { paths: [], omittedCount: 0 },
            trigger: 'threshold',
            createdAt: 1
          }
        ],
        state: {
          text: '当前状态不包含评估事实',
          coversThrough: { messageId: 'a-facts', step: 0 },
          taskVerbatim: null,
          realityLine: '',
          revision: 1
        },
        tailFrom: { messageId: 'u-tail', step: 0 }
      })
      persistCompactionSnapshot(store, recallSession.id, recallLedger)
      const artifacts = new ArtifactStore(tempDir)
      const toolContext: ToolContext = {
        workingDir: tempDir,
        readState: createReadState(),
        sessionStore: store,
        sessionId: recallSession.id,
        artifactStore: artifacts
      }
      let recalled = 0
      for (const [index, expected] of foldedFacts.entries()) {
        const query = `任务约束 ${index + 1}`
        const result = await historyReadTool.execute(
          { operation: 'search', query },
          toolContext
        )
        const read = await historyReadTool.execute({ operation: 'read', checkpoint: 'c1' }, toolContext)
        if (result.success && read.success && read.output.includes(expected)) recalled++
      }

      const baselineRequest = requestStats(legacyRestored)
      const ledgerRequest = requestStats(restored.messages)
      const metrics: CompactionEvalMetrics = {
        evidenceKind: 'synthetic-structure-only',
        snapshot: {
          scenarios: snapshotScenarios,
          minimumReductionPercent: Math.min(
            ...snapshotScenarios.map(scenario => scenario.reductionPercent)
          ),
          maximumReductionPercent: Math.max(
            ...snapshotScenarios.map(scenario => scenario.reductionPercent)
          )
        },
        midTurnRestore: {
          baselineRequestBytes: baselineRequest.bytes,
          ledgerRequestBytes: ledgerRequest.bytes,
          reductionPercent: roundPercent(
            (1 - ledgerRequest.bytes / baselineRequest.bytes) * 100
          ),
          baselineDuplicateToolCallIds: baselineRequest.duplicateToolCallIds,
          ledgerDuplicateToolCallIds: ledgerRequest.duplicateToolCallIds,
          duplicateToolCallReductionPercent: roundPercent(
            (1 - ledgerRequest.duplicateToolCallIds / baselineRequest.duplicateToolCallIds) * 100
          )
        },
        prefixStability: {
          baselineReusablePrefixPercent: baselinePrefixPercent,
          ledgerReusablePrefixPercent: ledgerPrefixPercent,
          improvementPercentagePoints: roundPercent(ledgerPrefixPercent - baselinePrefixPercent),
          estimatedTokensSavedPerProjectedRequest: nextRoundCurrent.diagnostics.estimatedTokensSaved
        },
        projectionSafety: {
          singleLineOriginalRequestBytes: requestStats(singleLineHistory).bytes,
          singleLineProjectedRequestBytes: requestStats(singleLineProjection.messages).bytes,
          singleLineReductionPercent: roundPercent(
            (1 - requestStats(singleLineProjection.messages).bytes
              / requestStats(singleLineHistory).bytes) * 100
          ),
          multilineOriginalRequestBytes: requestStats(stableHistory).bytes,
          multilineProjectedRequestBytes: requestStats(previousRoundEnd.messages).bytes,
          multilineReductionPercent: roundPercent(
            (1 - requestStats(previousRoundEnd.messages).bytes
              / requestStats(stableHistory).bytes) * 100
          ),
          nonInflating:
            singleLineProjection.diagnostics.estimatedTokensSaved >= 0
            && previousRoundEnd.diagnostics.estimatedTokensSaved >= 0
        },
        foldedHistoryRecall: {
          baselinePercent: null,
          literalReadPercent: roundPercent(recalled / foldedFacts.length * 100),
          queries: foldedFacts.length,
          improvementPercentagePoints: null
        }
      }

      console.info(`[compaction-eval] ${JSON.stringify(metrics)}`)

      expect(metrics.snapshot.scenarios).toHaveLength(3)
      expect(metrics.snapshot.minimumReductionPercent).toBeGreaterThanOrEqual(75)
      expect(metrics.midTurnRestore.baselineDuplicateToolCallIds).toBeGreaterThan(0)
      expect(metrics.midTurnRestore.ledgerDuplicateToolCallIds).toBe(0)
      expect(metrics.midTurnRestore.duplicateToolCallReductionPercent).toBe(100)
      expect(metrics.midTurnRestore.reductionPercent).toBeGreaterThan(0)
      expect(metrics.prefixStability.ledgerReusablePrefixPercent).toBe(100)
      expect(metrics.prefixStability.improvementPercentagePoints).toBeGreaterThan(0)
      expect(metrics.prefixStability.estimatedTokensSavedPerProjectedRequest).toBeGreaterThan(0)
      expect(metrics.foldedHistoryRecall.literalReadPercent).toBe(100)
      expect(metrics.foldedHistoryRecall.improvementPercentagePoints).toBeNull()
      expect(metrics.projectionSafety.singleLineReductionPercent).toBeGreaterThan(0)
      expect(metrics.projectionSafety.multilineReductionPercent).toBeGreaterThan(0)
      expect(metrics.projectionSafety.nonInflating).toBe(true)
    } finally {
      // 先经 Owner 关闭索引连接，再删临时目录，避免 Windows 上 messages-index.sqlite EBUSY
      resetSessionIndexHostForTests()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
