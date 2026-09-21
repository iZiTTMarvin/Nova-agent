// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPopoverReentrancyGuard } from '../../../src/renderer/installPopoverReentrancyGuard'

describe('installPopoverReentrancyGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('重入 InvalidStateError 时延后重试，不把异常抛到页面', async () => {
    const original = HTMLElement.prototype.showPopover
    let calls = 0
    HTMLElement.prototype.showPopover = function () {
      calls += 1
      if (calls === 1) {
        throw new DOMException(
          "Failed to execute 'showPopover' on 'HTMLElement': Invalid to show a popover during another show operation",
          'InvalidStateError'
        )
      }
    }

    try {
      installPopoverReentrancyGuard()
      const el = document.createElement('div')
      expect(() => el.showPopover()).not.toThrow()
      expect(calls).toBe(1)
      await Promise.resolve()
      expect(calls).toBe(2)
    } finally {
      HTMLElement.prototype.showPopover = original
    }
  })
})
