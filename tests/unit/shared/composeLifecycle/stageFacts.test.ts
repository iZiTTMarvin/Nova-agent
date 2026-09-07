import { describe, expect, it } from 'vitest'
import {
  getStageCompleteDenial,
  type ComposeStageFacts,
  type ComposeStageId
} from '../../../../src/shared/composeLifecycle'

const CLOSED: ComposeStageFacts = { criticCompleted: false, inspectorPassed: false }
const CRITIC_DONE: ComposeStageFacts = { criticCompleted: true, inspectorPassed: false }
const INSPECTOR_PASSED: ComposeStageFacts = { criticCompleted: false, inspectorPassed: true }
const BOTH: ComposeStageFacts = { criticCompleted: true, inspectorPassed: true }

describe('getStageCompleteDenial', () => {
  it('图阶段：没有批评者完成则拒绝', () => {
    expect(getStageCompleteDenial('blueprint', CLOSED)).toBe(
      '一页纸还没有经过批评者挑刺。先派 critic 子代理审一遍，把砍掉和补上的写进一页纸，再完成本阶段。'
    )
  })

  it('图阶段：批评者已完成则放行', () => {
    expect(getStageCompleteDenial('blueprint', CRITIC_DONE)).toBeNull()
    expect(getStageCompleteDenial('blueprint', BOTH)).toBeNull()
  })

  it('验阶段：没有核验通过则拒绝', () => {
    expect(getStageCompleteDenial('inspect', CLOSED)).toBe(
      '还没有独立核验通过的记录。派 inspector 子代理按一页纸逐条操作；未通过就回到「锤」修，通过后再完成本阶段。'
    )
    expect(getStageCompleteDenial('inspect', CRITIC_DONE)).toBe(
      '还没有独立核验通过的记录。派 inspector 子代理按一页纸逐条操作；未通过就回到「锤」修，通过后再完成本阶段。'
    )
  })

  it('验阶段：核验已通过则放行', () => {
    expect(getStageCompleteDenial('inspect', INSPECTOR_PASSED)).toBeNull()
    expect(getStageCompleteDenial('inspect', BOTH)).toBeNull()
  })

  it('其他阶段一律不拦', () => {
    const others: ComposeStageId[] = ['interview', 'build', 'deliver']
    for (const stageId of others) {
      expect(getStageCompleteDenial(stageId, CLOSED)).toBeNull()
      expect(getStageCompleteDenial(stageId, BOTH)).toBeNull()
    }
  })
})
