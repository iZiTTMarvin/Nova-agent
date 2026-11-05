import { describe, expect, it } from 'vitest'
import { projectLearningPreset } from '../../../../src/runtime/learning/preset/projectLearningPreset'
import { LEARNING_SUGGESTIONS_FENCE } from '../../../../src/shared/learning/suggestions'

describe('projectLearningPreset', () => {
  it('角色材料保留讲解口吻与学习工具约束，不引入 Skill 依赖', () => {
    const material = projectLearningPreset.roleMaterial
    expect(material).toContain('learning_checkpoint')
    expect(material).toContain('learning_assess')
    expect(material).toContain('cursorVersion')
    expect(material).toContain('严禁考察死记硬背')
    expect(material).toContain('不要复述用户原话')
    expect(material).toContain('present_visualization')
    expect(material).toContain('默认只讲不考')
    expect(material.toLowerCase()).not.toContain('skill')
  })

  it('要求回复末尾写的推荐块与 Renderer 解析的围栏同名', () => {
    expect(projectLearningPreset.roleMaterial).toContain('```' + LEARNING_SUGGESTIONS_FENCE)
  })

  it('讲解直接回应当前问题，再讲用途与运行顺序，例子不出知识点的场景', () => {
    const material = projectLearningPreset.roleMaterial
    // 教学主线：直接回应、说清用途、按运行顺序铺开，术语不能代替机制解释
    expect(material).toContain('先直接回应用户当前的问题')
    expect(material).toContain('说清它是干什么的')
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

  it('每轮指令是固定文本，并在离生成最近的位置重申推荐块', () => {
    expect(projectLearningPreset.renderTurnInstruction()).toBe(
      [
        '[当前模式: learn — 项目讲解]',
        '只读源码与大纲；应用内学习状态仅通过 learning_checkpoint / learning_assess 写入。',
        '禁止修改仓库、执行 shell、编排子代理或切换模式；需要改代码请返回开发会话。',
        '用户选主题、答题与跳过由产品命令处理，不要替用户执行这些动作。',
        `本轮回答末尾按【下一步推荐】附 \`\`\`${LEARNING_SUGGESTIONS_FENCE} 代码块，2–3 条贴着本轮内容和用户刚才的话；本轮出了题就不写。`
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

  it('默认讲清机制与设计，代码位置和出处只在需要时展开', () => {
    const material = projectLearningPreset.roleMaterial
    expect(material).toContain('不出现代码块、文件行号或实现函数串')
    expect(material).toContain('用户明确问「在哪里实现」')
    expect(material).toContain('默认只用于核对事实与后续定位')
    expect(material).toContain('每段代码都要说明它负责什么、输入输出和关键判断')
    expect(material).not.toContain('1–3 个关键代码位置')
    expect(material).not.toContain('没有大纲时直接写 path:line')
  })
})
