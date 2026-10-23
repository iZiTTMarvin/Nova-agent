import { describe, expect, it } from 'vitest'
import {
  PRESENT_VISUALIZATION_DESCRIPTION,
  renderLearnVisualGuide
} from '../../../../src/runtime/visualizations/visualAuthoringGuide'
import { VISUALIZATION_BASE_STYLE } from '../../../../src/runtime/visualizations/visualizationStyles'
import { getLearnCoachRoleMaterial } from '../../../../src/runtime/learning/teaching/coachRoleMaterial'
import {
  INLINE_UI_ACTIONS,
  INLINE_UI_COMPONENTS,
  INLINE_UI_FUNCTIONS,
  initialInlineUiVars,
  parseInlineUi,
  renderInlineUi
} from '../../../../src/renderer/features/inline-ui/inlineUiLanguage'

const openUiBlocks = (text: string): string[] =>
  [...text.matchAll(/```openui\n([\s\S]*?)\n```/g)].map(match => match[1])

const section = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start)
  expect(start, `缺少段落 ${from}`).toBeGreaterThanOrEqual(0)
  return text.slice(start, end)
}

describe('visualAuthoringGuide', () => {
  it('写法说明列出的组件与函数和解析器实现一致', () => {
    const reference = renderLearnVisualGuide()
    const components = new Set(
      [...section(reference, 'Components', 'Functions:').matchAll(/\b([A-Z][A-Za-z]*)\(/g)].map(m => m[1])
    )
    expect([...components].sort()).toEqual([...INLINE_UI_COMPONENTS].sort())
    const functions = new Set(
      [...section(reference, 'Functions:', 'Rules').matchAll(/@([A-Z][A-Za-z]*)/g)].map(m => m[1])
    )
    expect([...functions].sort()).toEqual([...INLINE_UI_FUNCTIONS, ...INLINE_UI_ACTIONS].sort())
  })

  it('每个示例都能被解析器完整渲染，没有落空的引用', () => {
    const examples = openUiBlocks(renderLearnVisualGuide())
    expect(examples.length).toBeGreaterThanOrEqual(4)
    for (const code of examples) {
      const program = parseInlineUi(code)
      expect(program, code).not.toBeNull()
      const tree = renderInlineUi(program!, initialInlineUiVars(program!))
      expect(tree, code).not.toBeNull()
      expect(JSON.stringify(tree), code).not.toContain('"—"')
    }
  })

  it('HTML 写法里提到的内置类都在帧的共享样式里，模型照写不会落到无样式', () => {
    const html = section(renderLearnVisualGuide(), '## Full visual', '\u0000')
    const mentioned = new Set([...html.matchAll(/\.(viz-[a-z0-9-]+)/g)].map(m => m[1]))
    expect(mentioned.size).toBeGreaterThan(20)
    const missing = [...mentioned].filter(name => !VISUALIZATION_BASE_STYLE.includes(`.${name}`))
    expect(missing).toEqual([])
  })

  it('工具说明指向学习系统提示里真实存在的段落', () => {
    const material = getLearnCoachRoleMaterial()
    for (const heading of ['可视化讲解', '可视化写法']) {
      expect(PRESENT_VISUALIZATION_DESCRIPTION).toContain(heading)
      expect(material).toContain(`【${heading}】`)
    }
    expect(material).toContain(renderLearnVisualGuide())
  })
})
