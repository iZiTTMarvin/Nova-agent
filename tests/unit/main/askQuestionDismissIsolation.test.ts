/**
 * askQuestion 按会话 dismiss 单测。
 *
 * 验证问题2修复：并发模型下用户在某会话发新消息时，只 dismiss 该会话的挂起提问，
 * 不误杀并发中其它会话正在等待的提问（否则会让别的会话的 agent 拿空回答跑偏）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pendingAskQuestions,
  dismissPendingAskQuestionsForSession,
  dismissPendingAskQuestionsForRun,
  type PendingAskQuestionEntry
} from '../../../src/main/agent/interaction/askQuestionWaiters'
import { EventBus } from '../../../src/runtime/agent/EventBus'

function makeEntry(sessionId: string, runId: string): {
  entry: PendingAskQuestionEntry
  resolved: Promise<AskQuestionAnswer[]>
} {
  let resolve!: (a: AskQuestionAnswer[]) => void
  const resolved = new Promise<AskQuestionAnswer[]>((r) => {
    resolve = r
  })
  return {
    entry: { sessionId, runId, resolve, eventBus: new EventBus() },
    resolved
  }
}

type AskQuestionAnswer = unknown[]

describe('askQuestion 按会话 / 按 run dismiss 隔离', () => {
  beforeEach(() => {
    pendingAskQuestions.clear()
  })
  afterEach(() => {
    pendingAskQuestions.clear()
  })

  it('按会话 dismiss 只清该会话的挂起提问，不影响其它会话', async () => {
    const a = makeEntry('sessionA', 'runA')
    const b = makeEntry('sessionB', 'runB')
    pendingAskQuestions.set('reqA', a.entry)
    pendingAskQuestions.set('reqB', b.entry)

    // 会话 A 发新消息 → 只 dismiss A
    dismissPendingAskQuestionsForSession('sessionA')

    // A 已被结算（空 answers）
    const aResult = await a.resolved
    expect(aResult).toEqual([])
    expect(pendingAskQuestions.has('reqA')).toBe(false)

    // B 仍挂起，未被误杀
    expect(pendingAskQuestions.has('reqB')).toBe(true)
    // 手动结算 B 确认 resolver 未被提前调用
    b.entry.resolve([['answer']] as never)
    const bResult = await b.resolved
    expect(bResult).toHaveLength(1)
  })

  it('按 run dismiss 只清该 run 的挂起提问', async () => {
    const a = makeEntry('sessionA', 'runA')
    const b = makeEntry('sessionA', 'runB')
    pendingAskQuestions.set('reqA', a.entry)
    pendingAskQuestions.set('reqB', b.entry)

    dismissPendingAskQuestionsForRun('runA')
    expect(pendingAskQuestions.has('reqA')).toBe(false)
    expect(pendingAskQuestions.has('reqB')).toBe(true)
    const aResult = await a.resolved
    expect(aResult).toEqual([])
  })

  it('无挂起提问时 dismiss 不抛错', () => {
    expect(() => dismissPendingAskQuestionsForSession('nope')).not.toThrow()
    expect(() => dismissPendingAskQuestionsForRun('nope')).not.toThrow()
  })
})
