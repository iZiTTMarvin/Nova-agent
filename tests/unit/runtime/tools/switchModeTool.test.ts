import { describe, expect, it, vi } from 'vitest'
import { switchModeTool } from '../../../../src/runtime/tools/switchMode'
import { createReadState } from '../../../../src/runtime/tools/editTool'

describe('switch_mode', () => {
  it('把批准后的 plan -> default 切换委托给宿主', async () => {
    const switchMode = vi.fn(async () => ({
      previousMode: 'plan' as const,
      currentMode: 'default' as const
    }))
    const result = await switchModeTool.execute(
      { mode: 'default', reason: '计划已确认，开始实施' },
      { workingDir: 'D:\\workspace', readState: createReadState(), switchMode }
    )

    expect(result.success).toBe(true)
    expect(switchMode).toHaveBeenCalledWith('default', '计划已确认，开始实施')
    expect(result.output).toContain('active plan')
    expect(result.control).toEqual({
      type: 'mode_transition',
      previousMode: 'plan',
      currentMode: 'default'
    })
  })

  it('进入 plan 后返回同任务续跑控制信号', async () => {
    const switchMode = vi.fn(async () => ({
      previousMode: 'default' as const,
      currentMode: 'plan' as const
    }))
    const result = await switchModeTool.execute(
      { mode: 'plan', reason: '任务复杂，先形成计划' },
      { workingDir: 'D:\\workspace', readState: createReadState(), switchMode }
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('立即在 plan 模式继续')
    expect(result.control).toEqual({
      type: 'mode_transition',
      previousMode: 'default',
      currentMode: 'plan'
    })
  })

  it('拒绝未定义目标和缺少宿主回调', async () => {
    const invalid = await switchModeTool.execute(
      { mode: 'compose', reason: '绕过流程' },
      { workingDir: 'D:\\workspace', readState: createReadState() }
    )
    expect(invalid.success).toBe(false)

    const missingHost = await switchModeTool.execute(
      { mode: 'default', reason: '实施' },
      { workingDir: 'D:\\workspace', readState: createReadState() }
    )
    expect(missingHost.success).toBe(false)
    expect(missingHost.error).toContain('宿主')
  })
})
