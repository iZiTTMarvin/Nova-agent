import { describe, expect, it } from 'vitest'
import { getModeInstruction } from '../../../../src/runtime/agent/promptBuilder/modeInstruction'

describe('modeInstruction', () => {
  it('Plan 明确受限计划产物与确认后切换契约', () => {
    const instruction = getModeInstruction('plan')
    expect(instruction).toContain('save_plan')
    expect(instruction).toContain('.nova/plans/')
    expect(instruction).toContain('switch_mode')
    expect(instruction).toContain('计划审阅卡')
    expect(instruction).toContain('开始实施')
    expect(instruction).toContain('继续完善')
    expect(instruction).toContain('禁止修改业务文件')
  })

  it('Default 只在存在合法 active plan 时注入实施指针', () => {
    const withPlan = getModeInstruction('default', {
      activePlanPath: '.nova/plans/2026-07-24-auth.md'
    })
    expect(withPlan).toContain('.nova/plans/2026-07-24-auth.md')
    expect(withPlan).toContain('先读取')

    expect(getModeInstruction('default')).not.toContain('active plan')
  })

  it('Default 指示复杂任务自动进入 Plan 并在当前任务继续', () => {
    const instruction = getModeInstruction('default')
    expect(instruction).toContain('先调用 switch_mode 进入 plan')
    expect(instruction).toContain('当前任务中继续')
    expect(instruction).toContain('不需要额外征求用户确认')
    expect(instruction).toContain('不要滥用计划模式')
  })
})
