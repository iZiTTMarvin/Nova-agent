/**
 * useStreamingRenderPool — 流式文本的渲染节奏控制器
 *
 * 控制"用户看到的字符放出节奏"：
 * - 模型可以一次 burst 吐出几千字，但用户视觉上希望看到稳定打字机效果
 * - 该 hook 维护一个"已放出长度"（renderedLength），按固定帧率逐步放出
 * - 流式结束时立即放出全部，避免内容被截断
 *
 * 追赶算法（getCatchupStep）：
 * - poolSize ≤ smallPoolChars：固定 220 chars/s 打字机效果
 * - 120 ~ 720：max(固定, 14% pool)
 * - 720 ~ 2400：max(固定, 20% pool)
 * - > 2400：max(固定, 28% pool, 3600 上限)
 *
 * 设计参考 OpenCowork useStreamingRenderPool，根据 nova-agent 实际参数微调。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

export type RenderStyle = 'agile' | 'elegant'

export interface RenderPoolConfig {
  /** 基础打字机速度（字符/秒） */
  fixedCharsPerSecond: number
  /** 帧间隔（agile 32ms ≈ 31fps，elegant 36ms ≈ 28fps） */
  frameIntervalMs: number
  /** 小池阈值（≤ 此值按固定速度放） */
  smallPoolChars: number
  /** 中池阈值 */
  mediumPoolChars: number
  /** 大池阈值 */
  largePoolChars: number
  /** 单帧最大放出量（防跳帧） */
  maxStepChars: number
}

export const RENDER_POOL_CONFIG: Record<RenderStyle, RenderPoolConfig> = {
  agile: {
    fixedCharsPerSecond: 220,
    frameIntervalMs: 32,
    smallPoolChars: 120,
    mediumPoolChars: 720,
    largePoolChars: 2400,
    maxStepChars: 3600
  },
  elegant: {
    fixedCharsPerSecond: 170,
    frameIntervalMs: 36,
    smallPoolChars: 96,
    mediumPoolChars: 560,
    largePoolChars: 1800,
    maxStepChars: 2800
  }
}

/**
 * 计算本帧应放出多少字符。
 * 暴露为纯函数供测试使用。
 */
export function getCatchupStep(poolSize: number, elapsedMs: number, config: RenderPoolConfig): number {
  if (poolSize <= 0) return 0
  const fixedStep = Math.max(1, Math.ceil((config.fixedCharsPerSecond * elapsedMs) / 1000))

  if (poolSize <= config.smallPoolChars) {
    return Math.min(poolSize, fixedStep)
  }

  const catchupRatio =
    poolSize <= config.mediumPoolChars ? 0.14 :
    poolSize <= config.largePoolChars ? 0.20 :
    0.28

  const catchupStep = Math.ceil(poolSize * catchupRatio)
  return Math.min(poolSize, Math.max(fixedStep, catchupStep), config.maxStepChars)
}

export interface RenderPoolResult {
  /** 当前可渲染的字符子串（流式期间为 fullText.slice(0, renderedLength)） */
  text: string
  /** 尚未放出的字符数 = fullText.length - renderedLength */
  poolSize: number
  /** 已放出的字符数 */
  renderedLength: number
  /** 上游完整文本长度（target） */
  targetLength: number
}

export interface UseStreamingRenderPoolOptions {
  /** rAF 实现，默认 globalThis.requestAnimationFrame（与 autoScroll 等模块一致） */
  requestFrame?: (cb: () => void) => number
  /** cancelFrame 实现，默认 globalThis.cancelAnimationFrame */
  cancelFrame?: (handle: number) => void
}

/**
 * useStreamingRenderPool — 流式文本渲染池 hook
 *
 * @param fullText 完整文本（来自 store 的 message block.content）
 * @param isStreaming 是否处于流式生成中
 * @param style 'agile' (32ms 帧) | 'elegant' (36ms 帧)，默认 agile
 * @param options 注入 rAF 实现（测试用）
 */
export function useStreamingRenderPool(
  fullText: string,
  isStreaming: boolean,
  style: RenderStyle = 'agile',
  options: UseStreamingRenderPoolOptions = {}
): RenderPoolResult {
  const config = RENDER_POOL_CONFIG[style]
  const requestFrame = options.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle))

  /** 目标长度（上游 fullText 长度） */
  const targetLength = fullText.length
  /** 已放出长度（受 rAF tick 控制逐步增长） */
  const [renderedLength, setRenderedLength] = useState<number>(() => targetLength)
  /** refs 让 rAF tick 能拿到最新值，避免 effect 重启 */
  const targetLengthRef = useRef(targetLength)
  const renderedLengthRef = useRef<number>(targetLength)
  const lastTickAtRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)

  // fullText 变化时同步 targetLength；如果非流式，立即把 renderedLength 拉到末尾
  useEffect(() => {
    targetLengthRef.current = targetLength
    if (!isStreaming) {
      // 流式结束：直接显示完整内容
      renderedLengthRef.current = targetLength
      setRenderedLength(targetLength)
    } else if (targetLength < renderedLengthRef.current) {
      // fullText 缩短（极少见，比如 content 被裁剪）→ 立即同步
      renderedLengthRef.current = targetLength
      setRenderedLength(targetLength)
    }
  }, [targetLength, isStreaming])

  // 流式期间启动 rAF tick 循环
  useEffect(() => {
    if (!isStreaming) return

    // 重新开始计时
    lastTickAtRef.current = 0

    const tick = (): void => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsedMs = lastTickAtRef.current > 0
        ? now - lastTickAtRef.current
        : config.frameIntervalMs

      if (elapsedMs >= config.frameIntervalMs) {
        lastTickAtRef.current = now
        const pool = Math.max(0, targetLengthRef.current - renderedLengthRef.current)
        if (pool > 0) {
          const step = getCatchupStep(pool, elapsedMs, config)
          const nextLength = Math.min(targetLengthRef.current, renderedLengthRef.current + step)
          renderedLengthRef.current = nextLength
          setRenderedLength(nextLength)
        }
      }

      rafRef.current = requestFrame(tick)
    }

    rafRef.current = requestFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [config, isStreaming, requestFrame, cancelFrame])

  const safeRenderedLength = Math.min(renderedLength, targetLength)

  // 派生 text：流式期间切片到 renderedLength，否则完整
  const text = useMemo(() => {
    if (!isStreaming) return fullText
    return fullText.slice(0, safeRenderedLength)
  }, [fullText, isStreaming, safeRenderedLength])

  return {
    text,
    poolSize: Math.max(0, targetLength - safeRenderedLength),
    renderedLength: safeRenderedLength,
    targetLength
  }
}
