import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { type ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useStreamingRenderPool, getCatchupStep, RENDER_POOL_CONFIG, type RenderPoolConfig } from '../../../src/renderer/hooks/useStreamingRenderPool'

/** 同步虚拟 rAF 调度器：tick 显式驱动，方便测试 */
function createFakeRaf() {
  let now = 0
  const pending: Array<{ id: number; cb: () => void }> = []
  let nextId = 1

  const requestFrame = (cb: () => void): number => {
    const id = nextId++
    pending.push({ id, cb })
    return id
  }
  const cancelFrame = (id: number): void => {
    const idx = pending.findIndex(p => p.id === id)
    if (idx !== -1) pending.splice(idx, 1)
  }
  const advance = (ms: number): void => {
    now += ms
    const due = pending.splice(0, pending.length)
    for (const p of due) p.cb()
  }
  const setNow = (value: number): void => {
    now = value
  }
  const getNow = (): number => now
  return { requestFrame, cancelFrame, advance, setNow, getNow, pending }
}

describe('getCatchupStep', () => {
  const cfg: RenderPoolConfig = RENDER_POOL_CONFIG.agile

  it('小池：按固定速度放（220 chars/s → 32ms 一帧约 7 chars）', () => {
    const step = getCatchupStep(100, 32, cfg)
    // 220 * 32 / 1000 = 7.04 → ceil = 8
    expect(step).toBe(8)
  })

  it('小池：poolSize 小于 fixedStep 时取 poolSize', () => {
    const step = getCatchupStep(3, 32, cfg)
    expect(step).toBe(3)
  })

  it('中池：按 14% pool 加速追赶', () => {
    const step = getCatchupStep(500, 32, cfg)
    // fixed = 8, 14% pool = 70 → max(8, 70) = 70
    expect(step).toBe(70)
  })

  it('大池（720~2400）：按 20% pool', () => {
    const step = getCatchupStep(1500, 32, cfg)
    // fixed = 8, 20% pool = 300 → max(8, 300) = 300
    expect(step).toBe(300)
  })

  it('超大量（>2400）：按 28% pool 但不超过 maxStepChars=3600', () => {
    const step = getCatchupStep(10000, 32, cfg)
    // fixed = 8, 28% pool = ceil(2800.0000000000005) = 2801, maxStep = 3600
    // min(10000, max(8, 2801), 3600) = 2801
    expect(step).toBe(2801)
  })

  it('ellegant 模式参数更小，节奏更慢', () => {
    const elegant = RENDER_POOL_CONFIG.elegant
    const step = getCatchupStep(500, 36, elegant)
    // fixed = 170 * 36 / 1000 = 6.12 → ceil = 7, 14% pool = 70
    expect(step).toBe(70)
  })

  it('poolSize = 0 不放任何字符', () => {
    expect(getCatchupStep(0, 32, cfg)).toBe(0)
  })

  it('elapsedMs = 0 时退化为 fixedStep 的最小值 1', () => {
    expect(getCatchupStep(100, 0, cfg)).toBe(1)
  })

  it('精确边界：smallPoolChars=120 时按小池（固定速度）', () => {
    // 恰好 120 时还是 ≤ smallPoolChars → 走固定速度分支
    const step = getCatchupStep(120, 32, cfg)
    // fixed = ceil(220 * 32 / 1000) = 8
    expect(step).toBe(8)
  })

  it('精确边界：smallPoolChars+1=121 时按中池（14% pool）', () => {
    // 121 超过 smallPoolChars 边界
    const step = getCatchupStep(121, 32, cfg)
    // fixed = 8, 14% * 121 = ceil(16.94) = 17 → max(8, 17) = 17
    expect(step).toBe(17)
  })

  it('精确边界：mediumPoolChars=720 临界', () => {
    // 720 仍然 ≤ mediumPoolChars → 14% pool
    const step = getCatchupStep(720, 32, cfg)
    // 14% * 720 = 100.8 → ceil = 101
    expect(step).toBe(101)
  })

  it('精确边界：mediumPoolChars+1=721 切到大池（20% pool）', () => {
    const step = getCatchupStep(721, 32, cfg)
    // 20% * 721 = 144.2 → ceil = 145
    expect(step).toBe(145)
  })

  it('精确边界：largePoolChars=2400 临界', () => {
    // 2400 仍然 ≤ largePoolChars → 20% pool
    const step = getCatchupStep(2400, 32, cfg)
    // 20% * 2400 = 480
    expect(step).toBe(480)
  })

  it('精确边界：largePoolChars+1=2401 切到超大量（28% pool）', () => {
    const step = getCatchupStep(2401, 32, cfg)
    // 28% * 2401 = 672.28 → ceil = 673
    expect(step).toBe(673)
  })

  it('maxStepChars 上限生效：超大量 + 长 elapsedMs 也不超过上限', () => {
    // 100000 pool，5000ms elapsed
    const step = getCatchupStep(100000, 5000, cfg)
    // fixed = 220*5 = 1100, 28% pool = 28000, max = 3600
    // min(100000, max(1100, 28000), 3600) = 3600
    expect(step).toBe(3600)
  })
})

describe('useStreamingRenderPool', () => {
  let fakeRaf: ReturnType<typeof createFakeRaf>
  let originalPerformance: typeof performance
  let originalRaf: typeof globalThis.requestAnimationFrame
  let originalCancelRaf: typeof globalThis.cancelAnimationFrame

  beforeEach(() => {
    fakeRaf = createFakeRaf()
    originalRaf = globalThis.requestAnimationFrame
    originalCancelRaf = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = fakeRaf.requestFrame as unknown as typeof globalThis.requestAnimationFrame
    globalThis.cancelAnimationFrame = fakeRaf.cancelFrame as unknown as typeof globalThis.cancelAnimationFrame
    originalPerformance = globalThis.performance
    globalThis.performance = { now: fakeRaf.getNow } as unknown as typeof performance
  })

  afterEach(() => {
    globalThis.performance = originalPerformance
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCancelRaf
  })

  /**
   * 用 react-test-renderer 渲染一个 Probe 组件，组件里调用 hook 并把结果
   * 存到 ref，外部断言 ref.current 的最新值。这样可以避免 testing-library 依赖。
   */
  function probeHook(props: { fullText: string; isStreaming: boolean; style?: 'agile' | 'elegant' }) {
    const ref: { current: ReturnType<typeof useStreamingRenderPool> | null } = { current: null }
    function Probe(): null {
      ref.current = useStreamingRenderPool(props.fullText, props.isStreaming, props.style)
      return null
    }
    return { ref, Probe }
  }

  it('非流式时直接返回完整文本', () => {
    const { ref, Probe } = probeHook({ fullText: 'hello world', isStreaming: false })
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    expect(ref.current).not.toBeNull()
    expect(ref.current!.text).toBe('hello world')
    expect(ref.current!.poolSize).toBe(0)
    expect(ref.current!.renderedLength).toBe(11)
    expect(ref.current!.targetLength).toBe(11)

    act(() => {
      renderer?.unmount()
    })
  })

  it('isStreaming 切换 false 时立即显示完整内容', () => {
    const props = { fullText: 'abc', isStreaming: true, style: 'agile' as const }
    const { ref, Probe } = probeHook(props)
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    // 流式结束 + fullText 变长
    act(() => {
      props.isStreaming = false
      props.fullText = 'abcde'
    })
    act(() => {
      renderer?.update(React.createElement(Probe))
    })

    expect(ref.current!.text).toBe('abcde')
    expect(ref.current!.renderedLength).toBe(5)

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式期间 rAF 推进后 renderedLength 应大于 0', () => {
    const props = { fullText: '这是一段很长的文字' + 'x'.repeat(100), isStreaming: true, style: 'agile' as const }
    const { ref, Probe } = probeHook(props)
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    // 流式期间首次挂载：renderedLength 从 0 开始（让打字机从头追赶 fullText）。
    // 这是渲染池打字机效果的关键不变量，对齐 useStreamingRenderPool 初始化策略。
    const initial = ref.current!.renderedLength
    expect(initial).toBe(0)

    // 推进 rAF：把内部 fakeRaf 推进一步，tick 应该真正推进 renderedLength
    act(() => {
      fakeRaf.advance(32)
    })

    // 关键断言：tick 推进后 renderedLength 应该 > 0 且不超过 targetLength
    expect(ref.current!.renderedLength).toBeGreaterThan(0)
    expect(ref.current!.renderedLength).toBeLessThanOrEqual(ref.current!.targetLength)

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式期间 fullText 持续增长：tick 真正推进了 renderedLength（核心追赶场景）', () => {
    // 关键场景：模型一边吐字一边累积 buffer。
    // 初始 fullText='a'，流式中首次挂载 renderedLength=0；
    // fullText 增长到 'a' + 'x'.repeat(500) → poolSize=501 → rAF tick 应逐步放出字符。
    const props = { fullText: 'a', isStreaming: true, style: 'agile' as const }
    const { ref, Probe } = probeHook(props)
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    // 流式期间首次挂载 renderedLength=0
    expect(ref.current!.renderedLength).toBe(0)
    expect(ref.current!.targetLength).toBe(1)
    expect(ref.current!.poolSize).toBe(1)

    // fullText 增长（模拟 streamDeltaBuffer 累积）
    act(() => {
      props.fullText = 'a' + 'x'.repeat(500)
    })
    act(() => {
      renderer?.update(React.createElement(Probe))
    })

    // 更新后：targetLength 跳到 501，renderedLength 仍为 0，poolSize = 501
    expect(ref.current!.targetLength).toBe(501)
    expect(ref.current!.poolSize).toBe(501)
    expect(ref.current!.renderedLength).toBe(0)

    // 推进 32ms 一次 rAF：tick 计算 step（501 是中池，14% ≈ 71），renderedLength 应增长
    act(() => {
      fakeRaf.advance(32)
    })
    const afterFirstTick = ref.current!.renderedLength
    expect(afterFirstTick).toBeGreaterThan(0) // 关键：tick 真的推进了

    // 继续推进多帧：renderedLength 应单调递增但不超过 targetLength
    act(() => {
      fakeRaf.advance(32)
    })
    act(() => {
      fakeRaf.advance(32)
    })
    expect(ref.current!.renderedLength).toBeGreaterThan(afterFirstTick)
    expect(ref.current!.renderedLength).toBeLessThanOrEqual(ref.current!.targetLength)

    // 再推进足够多帧（~50 帧 × 70 chars ≈ 3500 chars）把池子完全清掉
    for (let i = 0; i < 60; i++) {
      act(() => {
        fakeRaf.advance(32)
      })
    }
    expect(ref.current!.renderedLength).toBe(ref.current!.targetLength) // 追赶完成
    expect(ref.current!.poolSize).toBe(0)

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式期间 fullText 继续增长：已追上后再增长，poolSize 重现非零', () => {
    // 边界：保证追赶不是 one-shot，而是持续可工作
    const props = { fullText: 'hello', isStreaming: true, style: 'agile' as const }
    const { ref, Probe } = probeHook(props)
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    // 推进足够多帧把 5 个字符追上
    for (let i = 0; i < 5; i++) {
      act(() => {
        fakeRaf.advance(32)
      })
    }
    expect(ref.current!.renderedLength).toBe(5)
    expect(ref.current!.poolSize).toBe(0)

    // 模型继续吐字
    act(() => {
      props.fullText = 'hello' + 'y'.repeat(200)
    })
    act(() => {
      renderer?.update(React.createElement(Probe))
    })
    expect(ref.current!.targetLength).toBe(205)
    expect(ref.current!.poolSize).toBe(200)

    // 推进一帧：应再次开始追赶
    act(() => {
      fakeRaf.advance(32)
    })
    expect(ref.current!.renderedLength).toBeGreaterThan(5)

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式期间每次 tick 调用后 renderedLength 不会倒退（单调递增）', () => {
    // 反向断言：追赶算法不应当"多放出字符"
    const props = { fullText: 'seed', isStreaming: true, style: 'agile' as const }
    const { ref, Probe } = probeHook(props)
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe))
    })

    let last = ref.current!.renderedLength
    for (let i = 0; i < 10; i++) {
      // 每帧都同时增长 fullText，模拟真实流式累积
      act(() => {
        props.fullText = props.fullText + 'x'.repeat(50)
      })
      act(() => {
        renderer?.update(React.createElement(Probe))
      })
      act(() => {
        fakeRaf.advance(32)
      })
      const cur = ref.current!.renderedLength
      expect(cur).toBeGreaterThanOrEqual(last)
      expect(cur).toBeLessThanOrEqual(ref.current!.targetLength)
      last = cur
    }

    act(() => {
      renderer?.unmount()
    })
  })
})
