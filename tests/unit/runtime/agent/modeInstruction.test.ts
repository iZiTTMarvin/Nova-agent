import { describe, expect, it } from 'vitest'
import {
  getHeadlessExecutionInstruction,
  getModeInstruction
} from '../../../../src/runtime/agent/promptBuilder/modeInstruction'

describe('modeInstruction', () => {
  it('headless 只要求直接实施与验证，不引导交互式切换', () => {
    const instruction = getHeadlessExecutionInstruction()

    expect(instruction).toContain('headless coding task')
    expect(instruction).toContain('运行与改动匹配的测试或检查')
    expect(instruction).not.toContain('switch_mode')
    expect(instruction).not.toContain('用户设置')
  })

  it('Plan 保存后立即通过 switch_mode 发起结构化审阅', () => {
    const instruction = getModeInstruction('plan')
    expect(instruction).toContain('save_plan')
    expect(instruction).toContain('.nova/plans/')
    expect(instruction).toContain('立即调用 switch_mode(mode: default)')
    expect(instruction).toContain('批准、更正或忽略')
    expect(instruction).toContain('不要先结束本轮')
    expect(instruction).toContain('禁止修改业务文件')
  })

  it('Plan 不用 askQuestion 复制计划审批路径', () => {
    const instruction = getModeInstruction('plan')
    expect(instruction).toContain('不要用 askQuestion')
    expect(instruction).toContain('同一 run 内恢复 switch_mode')
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

  it('Compose 为 XForge 锻造五步，主 agent 是唯一叙述者', () => {
    const instruction = getModeInstruction('compose')
    expect(instruction).toContain('[当前模式: compose — XForge 锻造]')
    expect(instruction).toContain('问 → 图 → 锤 → 验 → 交')
    expect(instruction).toContain('唯一叙述者')
    expect(instruction).toContain('阶段指南')
    expect(instruction).toContain('stage_transition')
    expect(instruction).toContain('complete')
    expect(instruction).toContain('skip')
    expect(instruction).toContain('return')
    expect(instruction).toContain('askQuestion')
  })

  it('Compose 门禁被拒时按提示补齐，不绕过', () => {
    const instruction = getModeInstruction('compose')
    expect(instruction).toContain('被拒')
    expect(instruction).toContain('补齐')
    expect(instruction).toContain('不要绕过')
  })

  it('Compose 保留不自动发布与危险命令拦截约束', () => {
    const instruction = getModeInstruction('compose')
    expect(instruction).toContain('不自动执行 git commit、push 或 deploy')
    expect(instruction).toContain('危险命令仍会被拦截')
  })
})
