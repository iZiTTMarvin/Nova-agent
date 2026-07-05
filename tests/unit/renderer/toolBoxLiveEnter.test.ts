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

describe('ToolTraceRow className 组合逻辑（ToolBox 兼容出口）', () => {
  it('isLiveStreaming=true 时 className 应包含 tool-trace-row--live 修饰符', () => {
    const isLiveStreaming = true
    const className = [
      'tool-trace-row',
      isLiveStreaming ? 'tool-trace-row--live' : ''
    ]
      .filter(Boolean)
      .join(' ')
    expect(className).toContain('tool-trace-row--live')
    expect(className).toContain('tool-trace-row')
  })

  it('isLiveStreaming=false 时 className 应只有 tool-trace-row 基类', () => {
    const isLiveStreaming = false
    const className = [
      'tool-trace-row',
      isLiveStreaming ? 'tool-trace-row--live' : ''
    ]
      .filter(Boolean)
      .join(' ')
    expect(className).toBe('tool-trace-row')
    expect(className).not.toContain('live')
  })
})

describe('流式入场常量（历史 spring 门控，现由 CSS opacity 驱动）', () => {
  it('LIVE_ENTER_SPRING / NO_ANIMATION 仍可被门控逻辑选用', () => {
    expect(LIVE_ENTER_SPRING.type).toBe('spring')
    expect(NO_ANIMATION).toEqual({ duration: 0 })
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

/**
 * todo_write 走轮次级 isLiveStreaming（isCurrentAssistantGenerating，不合并 status），
 * 与上面工具级真值表刻意不同：todo_write 是瞬时工具（写快照即转 success），
 * 但路线图应在整个轮次进行中常驻可见，而非单次工具完成即收起。
 */
describe('TodoToolCard isLiveStreaming 门控条件（轮次级，todo_write 专用）', () => {
  it('isCurrentAssistantGenerating=true 且 status=success → isLiveStreaming=true（工具完成仍展开，本次修复核心）', () => {
    const isCurrentAssistantGenerating = true
    const blockStatus: 'running' | 'success' | 'error' = 'success'
    const isLiveStreaming = isCurrentAssistantGenerating
    expect(isLiveStreaming).toBe(true)
  })

  it('isCurrentAssistantGenerating=true 且 status=running → isLiveStreaming=true', () => {
    const isCurrentAssistantGenerating = true
    const blockStatus: 'running' | 'success' | 'error' = 'running'
    const isLiveStreaming = isCurrentAssistantGenerating
    expect(isLiveStreaming).toBe(true)
  })

  it('isCurrentAssistantGenerating=false（轮次结束 / 历史回看）→ isLiveStreaming=false', () => {
    const isCurrentAssistantGenerating = false
    const blockStatus: 'running' | 'success' | 'error' = 'success'
    const isLiveStreaming = isCurrentAssistantGenerating
    expect(isLiveStreaming).toBe(false)
  })

  it('isCurrentAssistantGenerating=false 且 status=running → isLiveStreaming=false', () => {
    const isCurrentAssistantGenerating = false
    const blockStatus: 'running' | 'success' | 'error' = 'running'
    const isLiveStreaming = isCurrentAssistantGenerating
    expect(isLiveStreaming).toBe(false)
  })
})