/**
 * 发送前校验与 run 生命周期出口护栏。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { interruptStartedRunAfterFailure } from '../../../src/main/agent/turn/turnLifecycle'

const TURN_SERVICE = join(__dirname, '../../../src/main/agent/turn/AgentTurnService.ts')

describe('P0-3 preflight 不得留下 active run', () => {
  it(
    'AgentTurnService：startRun 必须位于图片/regenerate 校验之后（源码顺序护栏）',
    () => {
      const src = readFileSync(TURN_SERVICE, 'utf-8')

      const startRunIdx = src.indexOf('runCoordinator.startRun')
      expect(startRunIdx).toBeGreaterThan(0)

      const beforeStart = src.slice(0, startRunIdx)
      // 图片/regenerate 的 throw 文案必须出现在 startRun 之前
      expect(beforeStart).toMatch(/不支持图片|重新生成失败/)
      const hasPreflightCall =
        /preflightSendMessage|assertSendPreflight|validateSendParams/.test(beforeStart)
      const hasInlineChecks = /不支持图片|重新生成失败/.test(beforeStart)
      expect(hasPreflightCall || hasInlineChecks).toBe(true)
    }
  )

  it('契约：startRun 后进程内清理与 terminal 提交分离，unregister 不依赖 commit 成功', () => {
    const src = readFileSync(TURN_SERVICE, 'utf-8')
    const afterStart = src.slice(src.indexOf('runCoordinator.startRun'))
    expect(afterStart).toMatch(/executionRegistered/)
    expect(afterStart).toMatch(/unregister\(/)
    expect(afterStart).toMatch(/disposeTurnStreams\(/)
    // terminal 提交包在独立 try 内，其后仍有外层 finally 做 registry 清理
    expect(afterStart).toMatch(/terminal 提交失败/)
    expect(afterStart).toMatch(/interruptStartedRunAfterFailure/)
  })

  it.each(['queued', 'running', 'resuming', 'waiting_user'] as const)(
    'startRun 后即使已 register，%s 状态的异常仍提交 interrupted',
    (status) => {
      const coordinator = {
        getSnapshot: vi.fn(() => ({ runId: 'run-1', status })),
        commitTerminal: vi.fn()
      }

      const committed = interruptStartedRunAfterFailure(
        coordinator,
        'run-1',
        new Error('setup failed')
      )

      expect(committed).toBe(true)
      expect(coordinator.commitTerminal).toHaveBeenCalledWith({
        runId: 'run-1',
        status: 'interrupted',
        reason: 'setup failed'
      })
    }
  )

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    '已有终态 %s 不被异常收敛覆盖',
    (status) => {
      const coordinator = {
        getSnapshot: vi.fn(() => ({ runId: 'run-1', status })),
        commitTerminal: vi.fn()
      }

      expect(interruptStartedRunAfterFailure(coordinator, 'run-1', 'late error')).toBe(false)
      expect(coordinator.commitTerminal).not.toHaveBeenCalled()
    }
  )
})
