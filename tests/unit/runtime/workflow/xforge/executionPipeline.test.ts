import { describe, expect, it, vi } from 'vitest'
import {
  XForgeExecutionPipeline,
  createInitialXForgeRunState,
  type XForgeRunState
} from '../../../../../src/runtime/workflow/xforge'

describe('XForgeExecutionPipeline', () => {
  it('fix 扩大范围返回 plan 后重新经过 M2，再进入 M3 直到终态', async () => {
    const preDelivery = {
      runPreDeliveryStages: vi.fn()
        .mockResolvedValueOnce(state('test'))
        .mockResolvedValueOnce(state('test'))
    }
    const delivery = {
      runDeliveryStages: vi.fn()
        .mockResolvedValueOnce(state('plan'))
        .mockResolvedValueOnce(state('completed'))
    }

    const result = await new XForgeExecutionPipeline(preDelivery, delivery).runToBoundary()

    expect(result.currentStage).toBe('completed')
    expect(preDelivery.runPreDeliveryStages).toHaveBeenCalledTimes(2)
    expect(delivery.runDeliveryStages).toHaveBeenCalledTimes(2)
  })

  it('waiting_user 原样停止，不盲目恢复', async () => {
    const waiting = state('waiting_user')
    const preDelivery = { runPreDeliveryStages: vi.fn(async () => waiting) }
    const delivery = { runDeliveryStages: vi.fn(async () => state('completed')) }

    const result = await new XForgeExecutionPipeline(preDelivery, delivery).runToBoundary()

    expect(result).toBe(waiting)
    expect(delivery.runDeliveryStages).not.toHaveBeenCalled()
  })
})

function state(currentStage: XForgeRunState['currentStage']): XForgeRunState {
  return createInitialXForgeRunState({ currentStage })
}
