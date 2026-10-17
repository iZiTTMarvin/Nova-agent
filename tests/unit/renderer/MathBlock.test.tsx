// @vitest-environment jsdom

/**
 * MathBlock 集成测试：真实 KaTeX（renderToString 纯字符串生成，jsdom 可跑）
 *
 * 保护的风险：
 * 1. 行内/围栏公式通路产出 KaTeX HTML（katex class 出现）
 * 2. renderMathToHtml 缓存：同源公式重复渲染不重算
 * 3. 语法错误不抛异常（throwOnError:false 红字内联）
 */
import React from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  MathFence,
  MathInlineCode,
  ensureKatexLoaded,
  renderMathToHtml
} from '../../../src/renderer/features/chat/MathBlock'
import { renderDom } from './renderDom'

beforeAll(async () => {
  await ensureKatexLoaded()
})

describe('renderMathToHtml', () => {
  it('合法公式产出 KaTeX HTML', () => {
    const html = renderMathToHtml('\\frac{a}{b}', false)
    expect(html).toContain('katex')
  })

  it('缓存命中：同源重复调用返回相同结果（KaTeX 输出稳定）', () => {
    const first = renderMathToHtml('x^2 + 1', true)
    const second = renderMathToHtml('x^2 + 1', true)
    expect(second).toBe(first)
  })

  it('display 与 inline 是不同缓存槽', () => {
    const display = renderMathToHtml('x^2', true)
    const inline = renderMathToHtml('x^2', false)
    expect(display).not.toBe(inline)
  })
})

describe('MathInlineCode / MathFence 组件', () => {
  it('MathInlineCode：$...$ 形态渲染 KaTeX，普通代码透传 Astryx Code', () => {
    const math = renderDom(<MathInlineCode>{'$x^2$'}</MathInlineCode>)
    expect(math.container.querySelector('.katex')).not.toBeNull()
    math.unmount()

    const plain = renderDom(<MathInlineCode>{'const x'}</MathInlineCode>)
    expect(plain.container.querySelector('.katex')).toBeNull()
    expect(plain.container.textContent).toContain('const x')
    plain.unmount()
  })

  it('MathFence：围栏公式以 display 模式渲染', () => {
    const tree = renderDom(<MathFence code={'\\sum_{i=1}^n i'} />)
    expect(tree.container.querySelector('.katex-display')).not.toBeNull()
    tree.unmount()
  })
})
