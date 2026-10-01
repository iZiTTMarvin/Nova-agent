import { describe, expect, it } from 'vitest'
import { projectLearningPreset } from '../../../../src/runtime/learning/preset/projectLearningPreset'

describe('projectLearningPreset', () => {
  it('角色材料保留讲解口吻与学习工具约束，不引入 Skill 依赖', () => {
    const material = projectLearningPreset.roleMaterial
    expect(material).toContain('learning_checkpoint')
    expect(material).toContain('learning_assess')
    expect(material).toContain('cursorVersion')
    expect(material).toContain('严禁考察死记硬背')
    expect(material).toContain('不要复述用户原话')
    expect(material.toLowerCase()).not.toContain('skill')
  })

  it('讲解先说用途再讲运行顺序，例子不出知识点的场景', () => {
    const material = projectLearningPreset.roleMaterial
    // 教学主线：用途先行、按运行顺序铺开、直觉建立后才给术语名
    expect(material).toContain('先说它是干什么的')
    expect(material).toContain('一步一步发生了什么')
    expect(material).toContain('不默认有背景知识')
    // 例子必须取自机制自身的真实场景，拒绝无关类比
    expect(material).toContain('不沾边的类比')
    // 没听懂就换基础层级重讲，并直接指出理解错在哪
    expect(material).toContain('从更基础的地方重讲')
    expect(material).toContain('直接说错在哪')
    // 拟人表达：连贯段落，不堆排版、不写总结式结尾
    expect(material).toContain('不写总结式结尾')
  })

  it('每轮指令等于四行固定文本', () => {
    expect(projectLearningPreset.renderTurnInstruction()).toBe(
      [
        '[当前模式: learn — 项目讲解]',
        '只读源码与大纲；应用内学习状态仅通过 learning_checkpoint / learning_assess 写入。',
        '禁止修改仓库、执行 shell、编排子代理或切换模式；需要改代码请返回开发会话。',
        '用户选主题、答题与跳过由产品命令处理，不要替用户执行这些动作。'
      ].join('\n')
    )
  })

  it('学习 Base Rules 不携带开发模式规则', () => {
    const rules = projectLearningPreset.baseRules
    expect(rules).not.toContain('agent_list')
    expect(rules).not.toContain('Delegate')
    expect(rules).not.toContain('bash')
    expect(rules).not.toContain('run the relevant tests')
  })
})
