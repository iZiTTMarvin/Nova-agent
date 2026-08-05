// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockVirtualizer, ctorCalls, setupCalls, cleanUpCalls } = vi.hoisted(() => {
  const ctorCalls = vi.fn()
  const setupCalls = vi.fn()
  const cleanUpCalls = vi.fn()

  class MockVirtualizer {
    constructor() {
      ctorCalls(this)
    }
    setup(el: HTMLElement) {
      setupCalls(el, this)
    }
    cleanUp() {
      cleanUpCalls(this)
    }
  }

  return { MockVirtualizer, ctorCalls, setupCalls, cleanUpCalls }
})

vi.mock('@pierre/diffs', () => ({
  Virtualizer: MockVirtualizer
}))

import { acquirePierreVirtualizer } from '../../../src/renderer/features/diff/pierreVirtualizer'

function makeElement(): HTMLElement {
  return document.createElement('div')
}

describe('acquirePierreVirtualizer 引用计数与复用', () => {
  beforeEach(() => {
    ctorCalls.mockClear()
    setupCalls.mockClear()
    cleanUpCalls.mockClear()
  })

  it('首次 acquire 创建并 setup 单个 Virtualizer', () => {
    const el = makeElement()
    const handle = acquirePierreVirtualizer(el)

    expect(ctorCalls).toHaveBeenCalledTimes(1)
    expect(setupCalls).toHaveBeenCalledTimes(1)
    expect(setupCalls).toHaveBeenCalledWith(el, expect.any(MockVirtualizer))
    expect(handle.virtualizer).toBeInstanceOf(MockVirtualizer)
    expect(cleanUpCalls).not.toHaveBeenCalled()
  })

  it('同一滚动容器多次 acquire 复用同一 Virtualizer，不重复 setup', () => {
    const el = makeElement()
    const a = acquirePierreVirtualizer(el)
    const b = acquirePierreVirtualizer(el)

    expect(ctorCalls).toHaveBeenCalledTimes(1)
    expect(setupCalls).toHaveBeenCalledTimes(1)
    expect(b.virtualizer).toBe(a.virtualizer)
  })

  it('不同滚动容器各自拥有独立 Virtualizer', () => {
    const elA = makeElement()
    const elB = makeElement()
    const a = acquirePierreVirtualizer(elA)
    const b = acquirePierreVirtualizer(elB)

    expect(ctorCalls).toHaveBeenCalledTimes(2)
    expect(setupCalls).toHaveBeenCalledTimes(2)
    expect(b.virtualizer).not.toBe(a.virtualizer)
  })

  it('部分 release 时引用计数大于零，不触发 cleanUp', () => {
    const el = makeElement()
    const a = acquirePierreVirtualizer(el)
    acquirePierreVirtualizer(el)

    a.release()

    expect(cleanUpCalls).not.toHaveBeenCalled()

    // 复用仍可用
    const c = acquirePierreVirtualizer(el)
    expect(c.virtualizer).toBe(a.virtualizer)
    expect(ctorCalls).toHaveBeenCalledTimes(1)
  })

  it('所有引用 release 归零后触发 cleanUp 并清理条目', () => {
    const el = makeElement()
    const a = acquirePierreVirtualizer(el)
    const shared = a.virtualizer
    const b = acquirePierreVirtualizer(el)

    a.release()
    expect(cleanUpCalls).not.toHaveBeenCalled()

    b.release()
    expect(cleanUpCalls).toHaveBeenCalledTimes(1)
    expect(cleanUpCalls).toHaveBeenCalledWith(shared)

    // 归零后再次 acquire 应创建全新 Virtualizer，证明旧条目已清理
    const c = acquirePierreVirtualizer(el)
    expect(ctorCalls).toHaveBeenCalledTimes(2)
    expect(setupCalls).toHaveBeenCalledTimes(2)
    expect(c.virtualizer).not.toBe(shared)
  })

  it('release 幂等：重复调用不重复扣减、不误触发 cleanUp', () => {
    const el = makeElement()
    const a = acquirePierreVirtualizer(el)
    const b = acquirePierreVirtualizer(el)
    const shared = a.virtualizer

    a.release()
    a.release()
    a.release()

    expect(cleanUpCalls).not.toHaveBeenCalled()

    b.release()
    expect(cleanUpCalls).toHaveBeenCalledTimes(1)
    expect(cleanUpCalls).toHaveBeenCalledWith(shared)
  })

  it('全部释放后再次 acquire-setup-cleanUp 可重复进行', () => {
    const el = makeElement()

    for (let round = 0; round < 3; round++) {
      const handle = acquirePierreVirtualizer(el)
      const v = handle.virtualizer
      handle.release()
      expect(cleanUpCalls).toHaveBeenNthCalledWith(round + 1, v)
    }

    expect(ctorCalls).toHaveBeenCalledTimes(3)
    expect(setupCalls).toHaveBeenCalledTimes(3)
  })
})
