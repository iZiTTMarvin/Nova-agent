import { describe, expect, it } from 'vitest'
import { resolveEntryLockAction } from '../../../src/main/agent/turn/entryLock'

describe('resolveEntryLockAction', () => {
  it('入口空闲时放行', () => {
    expect(resolveEntryLockAction({ turnInProgress: false })).toEqual({ kind: 'proceed' })
  })

  it('turn 占用时进入 steering', () => {
    expect(resolveEntryLockAction({ turnInProgress: true })).toEqual({ kind: 'steer' })
  })
})
