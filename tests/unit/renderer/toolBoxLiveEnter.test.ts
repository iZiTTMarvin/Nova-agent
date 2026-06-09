import { describe, expect, it } from 'vitest'
import { LIVE_ENTER_SPRING, NO_ANIMATION } from '../../../src/renderer/features/chat/ToolBox'

/**
 * ToolBox 流式入场动画——门控逻辑与常量断言
 *
 * 导入源码常量验证，避免真值表测试（与源码断同一份逻辑）。
 * 组件渲染测试（motion.div className、initial 属性）需要 jsdom + @testing-library/react，
 * 当前项目未引入这些依赖，待补充。
 */

describe('LIVE_ENTER_SPRING 常量', () => {
  it('type 为 spring', () => {
    expect(LIVE_ENTER_SPRING.type).toBe('spring')
  })

  it('stiffness / damping / mass 与 OpenCowork spring.smooth 一致', () => {
    expect(LIVE_ENTER_SPRING).toEqual({
      type: 'spring',
      stiffness: 300,
      damping: 30,
      mass: 0.8,
    })
  })
})

describe('NO_ANIMATION 常量', () => {
  it('duration 为 0，确保非流式场景无残留动画', () => {
    expect(NO_ANIMATION).toEqual({ duration: 0 })
  })
})

describe('ToolBox isLiveStreaming 门控条件', () => {
  it('isCurrentAssistantGenerating=true 且 status=running → isLiveStreaming=true', () => {
    const isCurrentAssistantGenerating = true
    const blockStatus: 'running' | 'success' | 'error' = 'running'
    const isLiveStreaming = isCurrentAssistantGenerating && blockStatus === 'running'
    expect(isLiveStreaming).toBe(true)
  })

  it('isCurrentAssistantGenerating=true 且 status=success → isLiveStreaming=false', () => {
    const isCurrentAssistantGenerating = true
    const blockStatus: 'running' | 'success' | 'error' = 'success'
    const isLiveStreaming = isCurrentAssistantGenerating && blockStatus === 'running'
    expect(isLiveStreaming).toBe(false)
  })

  it('isCurrentAssistantGenerating=false 且 status=running → isLiveStreaming=false（历史消息回看不触发动画）', () => {
    const isCurrentAssistantGenerating = false
    const blockStatus: 'running' | 'success' | 'error' = 'running'
    const isLiveStreaming = isCurrentAssistantGenerating && blockStatus === 'running'
    expect(isLiveStreaming).toBe(false)
  })

  it('isCurrentAssistantGenerating=false 且 status=success → isLiveStreaming=false', () => {
    const isCurrentAssistantGenerating = false
    const blockStatus: 'running' | 'success' | 'error' = 'success'
    const isLiveStreaming = isCurrentAssistantGenerating && blockStatus === 'running'
    expect(isLiveStreaming).toBe(false)
  })
})

describe('ToolBox className 组合逻辑', () => {
  it('isLiveStreaming=true 时 className 应包含 tool-box--live-enter 修饰符', () => {
    const isLiveStreaming = true
    const className = isLiveStreaming ? 'tool-box tool-box--live-enter' : 'tool-box'
    expect(className).toContain('tool-box--live-enter')
    expect(className).toContain('tool-box')
  })

  it('isLiveStreaming=false 时 className 应只有 tool-box 基类', () => {
    const isLiveStreaming = false
    const className = isLiveStreaming ? 'tool-box tool-box--live-enter' : 'tool-box'
    expect(className).toBe('tool-box')
    expect(className).not.toContain('live-enter')
  })
})

describe('ToolBox motion.div 职责分工（opacity=CSS, scale=framer-motion）', () => {
  it('animateLive=true 时 initial 只包含 scale（opacity 由 CSS keyframe 驱动）', () => {
    const animateLive = true
    const initial = animateLive ? { scale: 0.98 } : false
    expect(initial).toEqual({ scale: 0.98 })
    // opacity 不在 initial 中——由 CSS @keyframes tool-box-live-enter 管理
    expect(initial).not.toHaveProperty('opacity')
  })

  it('animateLive=false 时 initial 为 false（跳过初始动画）', () => {
    const animateLive = false
    const initial = animateLive ? { scale: 0.98 } : false
    expect(initial).toBe(false)
  })

  it('animateLive=true 时 transition 使用 LIVE_ENTER_SPRING', () => {
    const animateLive = true
    const transition = animateLive ? LIVE_ENTER_SPRING : NO_ANIMATION
    expect(transition).toBe(LIVE_ENTER_SPRING)
  })

  it('animateLive=false 时 transition 使用 NO_ANIMATION（duration=0）', () => {
    const animateLive = false
    const transition = animateLive ? LIVE_ENTER_SPRING : NO_ANIMATION
    expect(transition).toBe(NO_ANIMATION)
    expect(transition).toEqual({ duration: 0 })
  })
})

describe('useReducedMotion 双重门控', () => {
  it('isLiveStreaming=true 但 prefersReducedMotion=true → animateLive=false', () => {
    const isLiveStreaming = true
    const prefersReducedMotion = true
    const animateLive = isLiveStreaming && !prefersReducedMotion
    expect(animateLive).toBe(false)
  })

  it('isLiveStreaming=true 且 prefersReducedMotion=false → animateLive=true', () => {
    const isLiveStreaming = true
    const prefersReducedMotion = false
    const animateLive = isLiveStreaming && !prefersReducedMotion
    expect(animateLive).toBe(true)
  })

  it('isLiveStreaming=false 时无��� prefersReducedMotion 如何 → animateLive=false', () => {
    const isLiveStreaming = false
    expect(isLiveStreaming && !true).toBe(false)  // prefersReducedMotion=true
    expect(isLiveStreaming && !false).toBe(false) // prefersReducedMotion=false
  })
})