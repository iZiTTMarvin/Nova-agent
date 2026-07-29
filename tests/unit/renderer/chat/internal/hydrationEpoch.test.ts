import { describe, expect, it } from 'vitest'

import {
  invalidateHydrationEpoch,
  isHydrationEpochCurrent,
  nextHydrationEpoch,
} from '../../../../../src/renderer/stores/chat/internal/hydrationEpoch'

describe('hydrationEpoch', () => {
  it('makes only the latest epoch current and invalidates it explicitly', () => {
    const firstEpoch = nextHydrationEpoch()
    expect(isHydrationEpochCurrent(firstEpoch)).toBe(true)

    const secondEpoch = nextHydrationEpoch()
    expect(isHydrationEpochCurrent(firstEpoch)).toBe(false)
    expect(isHydrationEpochCurrent(secondEpoch)).toBe(true)

    invalidateHydrationEpoch()
    expect(isHydrationEpochCurrent(secondEpoch)).toBe(false)
  })
})
