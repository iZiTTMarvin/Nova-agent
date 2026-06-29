import { describe, it, expect, vi } from 'vitest'
import { preSendGate } from '../../../src/renderer/features/chat/sendOrchestration'

describe('preSendGate — askQuestion 死锁解除前置门', () => {
  it('无 pending askQuestion 时不调用 dismiss', async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined)
    const out = await preSendGate({ hasPendingAskQuestion: false, dismissAskQuestion: dismiss })
    expect(out.dismissedAskQuestion).toBe(false)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('有 pending askQuestion 时先 dismiss 再返回（解除"新消息进队列、旧轮次永不到 message_end"的死锁）', async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined)
    const out = await preSendGate({ hasPendingAskQuestion: true, dismissAskQuestion: dismiss })
    expect(out.dismissedAskQuestion).toBe(true)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismiss 的错误应向上冒泡，避免静默吞掉导致旧轮次仍未解除阻塞', async () => {
    const dismiss = vi.fn().mockRejectedValue(new Error('ipc fail'))
    await expect(
      preSendGate({ hasPendingAskQuestion: true, dismissAskQuestion: dismiss })
    ).rejects.toThrow('ipc fail')
  })
})
