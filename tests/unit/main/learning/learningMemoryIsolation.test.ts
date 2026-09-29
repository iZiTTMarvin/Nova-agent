/**
 * learn 会话与通用记忆的硬隔离（行为级回归）。
 * 真实 SessionStore / ObservationCapture / 记忆 hosts 全链路，仅 mock 设置加载
 * 与 episodic 写盘边界；default 对照组证明采集与落盘路径本身可用，
 * 回滚任一生产门控都会让 learn 断言变红。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const appendEpisodicMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'nova-learn-mem-iso-app-')) }
}))

vi.mock('../../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => ({ memoryEnabled: true })
}))

vi.mock('../../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => ({ appendEpisodicSummary: appendEpisodicMock }),
  getMemoryCandidateProcessor: () => ({ process: vi.fn() })
}))

import {
  initSessionStoreHost,
  resetSessionStoreHostForTests
} from '../../../../src/main/services/SessionStoreHost'
import {
  getObservationCaptureForSession,
  resetObservationCapturesForTests
} from '../../../../src/runtime/memory/ObservationCapture'
import {
  drainAndPersistSync,
  drainAndSchedulePersist
} from '../../../../src/main/services/MemoryConsolidationHost'
import {
  extractOnSessionLeave,
  onUserTurnCompleteForExtract,
  resetExtractTurnCountersForTests,
  runMemoryExtract
} from '../../../../src/main/services/MemoryExtractHost'
import { MEMORY_EXTRACT_INTERVAL_TURNS } from '../../../../src/runtime/memory/memoryConfig'

describe('learn 会话记忆硬隔离', () => {
  let sessionsRoot: string
  let learnId: string
  let defaultId: string

  beforeEach(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), 'nova-learn-mem-sess-'))
    resetSessionStoreHostForTests()
    resetObservationCapturesForTests()
    resetExtractTurnCountersForTests()
    appendEpisodicMock.mockClear()
    const store = initSessionStoreHost(sessionsRoot)
    learnId = store.create(join(sessionsRoot, 'ws-learn'), 'learn').id
    defaultId = store.create(join(sessionsRoot, 'ws-dev'), 'default').id
  })

  afterEach(() => {
    resetSessionStoreHostForTests()
    resetObservationCapturesForTests()
    rmSync(sessionsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  /** 模拟最坏情况：buffer 里已有残留工具轨迹（batch 参数绕开指纹去重，允许多次播种） */
  function seedObservations(sessionId: string, count: number, batch: number): void {
    const capture = getObservationCaptureForSession(sessionId)
    for (let i = 0; i < count; i++) {
      capture.onToolCall({
        sessionId,
        messageId: `m${batch}-${i}`,
        toolCallId: `tc-${sessionId}-${batch}-${i}`,
        toolName: 'read',
        args: { path: `src/file${batch}_${i}.ts` }
      })
      capture.onToolResult({
        sessionId,
        messageId: `m${batch}-${i}`,
        toolCallId: `tc-${sessionId}-${batch}-${i}`,
        toolName: 'read',
        result: `content ${batch}-${i}`
      })
    }
  }

  it('learn 会话即使存在残留轨迹，周期落盘、退出落盘与 drain 路径均不写 episodic', async () => {
    seedObservations(learnId, 3, 0)
    expect(getObservationCaptureForSession(learnId).getWorkingBuffer(learnId)).toHaveLength(3)

    for (let i = 0; i < MEMORY_EXTRACT_INTERVAL_TURNS; i++) {
      onUserTurnCompleteForExtract(learnId, join(sessionsRoot, 'ws-learn'))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))

    extractOnSessionLeave(learnId, join(sessionsRoot, 'ws-learn'))
    drainAndSchedulePersist(learnId, join(sessionsRoot, 'ws-learn'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    drainAndPersistSync(learnId, join(sessionsRoot, 'ws-learn'))

    expect(appendEpisodicMock).not.toHaveBeenCalled()
    // 早退不得顺带消费 buffer：残留证据原样保留
    expect(getObservationCaptureForSession(learnId).getWorkingBuffer(learnId)).toHaveLength(3)
  })

  it('default 会话对照组：同样的轨迹与触发点正常落盘', async () => {
    seedObservations(defaultId, 3, 0)
    expect(getObservationCaptureForSession(defaultId).getWorkingBuffer(defaultId)).toHaveLength(3)

    for (let i = 0; i < MEMORY_EXTRACT_INTERVAL_TURNS; i++) {
      onUserTurnCompleteForExtract(defaultId, join(sessionsRoot, 'ws-dev'))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(appendEpisodicMock).toHaveBeenCalledTimes(1)

    // 周期落盘已清空 buffer；换一批新指纹验证退出路径本身会写
    seedObservations(defaultId, 2, 1)
    extractOnSessionLeave(defaultId, join(sessionsRoot, 'ws-dev'))
    expect(appendEpisodicMock).toHaveBeenCalledTimes(2)
  })

  it('显式提炼入口对 learn 会话同样排除，不消费 buffer', async () => {
    seedObservations(learnId, 2, 0)
    await runMemoryExtract(learnId, join(sessionsRoot, 'ws-learn'), initSessionStoreHost(sessionsRoot))
    expect(appendEpisodicMock).not.toHaveBeenCalled()
    expect(getObservationCaptureForSession(learnId).getWorkingBuffer(learnId)).toHaveLength(2)
  })
})
