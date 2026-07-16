import type { XForgeRunState } from './runState'

export interface XForgePreDeliveryRunner {
  runPreDeliveryStages: () => Promise<XForgeRunState>
}

export interface XForgeDeliveryRunner {
  runDeliveryStages: () => Promise<XForgeRunState>
}

const PRE_DELIVERY_STAGES = new Set(['resolve', 'brainstorm', 'plan', 'scope_check', 'implement'])
const DELIVERY_STAGES = new Set(['test', 'review', 'fix', 'report'])

/**
 * 串联实施阶段与交付闭环。Fix 扩大范围回到 plan 时会重新经过 Plan/Scope/Implement，
 * 任何 waiting 或终态都会原样返回，不在编排层制造第二份状态。
 */
export class XForgeExecutionPipeline {
  constructor(
    private readonly preDelivery: XForgePreDeliveryRunner,
    private readonly delivery: XForgeDeliveryRunner
  ) {}

  async runToBoundary(): Promise<XForgeRunState> {
    while (true) {
      const state = await this.advance()
      if (PRE_DELIVERY_STAGES.has(state.currentStage) || DELIVERY_STAGES.has(state.currentStage)) {
        continue
      }
      return state
    }
  }

  private async advance(): Promise<XForgeRunState> {
    const state = await this.preDelivery.runPreDeliveryStages()
    if (DELIVERY_STAGES.has(state.currentStage)) {
      return this.delivery.runDeliveryStages()
    }
    return state
  }
}
