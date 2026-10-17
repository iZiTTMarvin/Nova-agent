/**
 * mathSyntax 单元测试：数学语法转译的边界规则与流式渐进语义
 */
import { describe, expect, it } from 'vitest'
import {
  findOpenDisplayMathStart,
  transformInlineMath,
  transformMathSyntax,
  unwrapInlineMathCode
} from '../../../src/renderer/features/chat/mathSyntax'

describe('transformMathSyntax：块级 $$ → math 围栏', () => {
  it('多行 $$ 块转译为 ```math 围栏，反斜杠内容原样保留', () => {
    const input = ['前文。', '', '$$', '\\frac{a}{b}', '\\sum_{i=1}^n i', '$$', '', '后文。'].join('\n')
    const { text, hasMath } = transformMathSyntax(input)
    expect(hasMath).toBe(true)
    expect(text).toContain('```math')
    expect(text).toContain('\\frac{a}{b}')
    expect(text).toContain('\\sum_{i=1}^n i')
    expect(text).not.toContain('$$')
    expect(text).toContain('前文。')
    expect(text).toContain('后文。')
  })

  it('单行 $$ x $$ 自闭合同样转译', () => {
    const { text, hasMath } = transformMathSyntax('$$ E = mc^2 $$')
    expect(hasMath).toBe(true)
    expect(text).toBe(['```math', 'E = mc^2', '```'].join('\n'))
  })

  it('未闭合 $$ 块保持原文（流式渐进：等闭合后再转译）', () => {
    const input = ['前文。', '', '$$', '\\frac{a}{b}'].join('\n')
    const { text, hasMath } = transformMathSyntax(input)
    expect(hasMath).toBe(false)
    expect(text).toBe(input)
  })

  it('闭合行带尾随文本：尾随文本保留在围栏之后', () => {
    const input = ['$$', 'x^2', '$$ 结束说明'].join('\n')
    const { text } = transformMathSyntax(input)
    expect(text).toContain('```math')
    expect(text).toContain('x^2')
    expect(text).toContain('结束说明')
  })

  it('围栏代码内的 $$ 不转译', () => {
    const input = ['```typescript', 'const s = "$$not math$$"', '```'].join('\n')
    const { text, hasMath } = transformMathSyntax(input)
    expect(hasMath).toBe(false)
    expect(text).toBe(input)
  })
})

describe('transformInlineMath：行内 $ → 行内代码标记', () => {
  it('正常行内公式转译，LaTeX 保真', () => {
    expect(transformInlineMath('价值是 $x^2 + 1$ 左右')).toBe('价值是 `$x^2 + 1$` 左右')
    expect(transformInlineMath('$\\frac{a}{b}$ 开头')).toBe('`$\\frac{a}{b}$` 开头')
  })

  it('货币不误判：闭符后跟数字拒绝、内容首尾空白拒绝', () => {
    expect(transformInlineMath('价格 $5 和 $10 之间')).toBe('价格 $5 和 $10 之间')
    expect(transformInlineMath('价格$100成本$200')).toBe('价格$100成本$200')
    expect(transformInlineMath('$ x $ 首尾空白')).toBe('$ x $ 首尾空白')
  })

  it('行内代码中的 $ 不转译', () => {
    expect(transformInlineMath('变量 `$var` 与 `$x$`')).toBe('变量 `$var` 与 `$x$`')
  })
})

describe('findOpenDisplayMathStart：未闭合 $$ 块定位', () => {
  it('未闭合块起点被定位', () => {
    const content = ['前文。', '', '$$', '\\frac{a}{b}'].join('\n')
    const open = findOpenDisplayMathStart(content, 0)
    expect(open).toBe(content.indexOf('$$'))
  })

  it('已闭合块不阻断，返回 -1', () => {
    const content = ['$$', 'x^2', '$$', '', '尾部还在写'].join('\n')
    expect(findOpenDisplayMathStart(content, 0)).toBe(-1)
  })

  it('from 起点只看后续内容（增量语义）', () => {
    const content = ['$$', 'x^2', '$$', '', '$$'].join('\n')
    const firstOpen = findOpenDisplayMathStart(content, 0)
    // 第一个块已闭合；第二个 $$ 未闭合
    const second = content.lastIndexOf('$$')
    expect(firstOpen).toBe(second)
  })

  it('围栏内的 $$ 不参与判定', () => {
    const content = ['```text', '$$', '```'].join('\n')
    expect(findOpenDisplayMathStart(content, 0)).toBe(-1)
  })
})

describe('unwrapInlineMathCode', () => {
  it('$...$ 形态解包', () => {
    expect(unwrapInlineMathCode('$x^2$')).toBe('x^2')
    expect(unwrapInlineMathCode('$\\frac{a}{b}$')).toBe('\\frac{a}{b}')
  })

  it('普通行内代码返回 null', () => {
    expect(unwrapInlineMathCode('$var')).toBeNull()
    expect(unwrapInlineMathCode('var`')).toBeNull()
    expect(unwrapInlineMathCode('$$')).toBeNull()
    expect(unwrapInlineMathCode('code')).toBeNull()
  })
})
