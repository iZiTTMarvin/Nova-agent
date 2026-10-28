// @vitest-environment jsdom

import React from 'react'
import { describe, expect, it } from 'vitest'
import { WebSearchCard } from '../../../src/renderer/features/chat/WebSearchCard'
import { act, renderDom } from './renderDom'

function output(count: number): string {
  const entries = Array.from({ length: count }, (_, i) =>
    `[${i + 1}] 来源${i + 1}\n    https://example.com/${i + 1}\n    摘要${i + 1}`
  )
  return `答案\n\n## Sources\n${entries.join('\n')}`
}

function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.web-search-card__source-title')].map(a => a.textContent ?? '')
}

describe('WebSearchCard 来源折叠', () => {
  it('来源超过两条时默认只显示前两条，可展开完整结果并收起', () => {
    const renderer = renderDom(<WebSearchCard output={output(5)} />)
    expect(titles(renderer.container)).toEqual(['来源1', '来源2'])
    const button = renderer.container.querySelector<HTMLButtonElement>('.web-search-card__more')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.textContent).toContain('共 5 条')

    act(() => { button.click() })
    expect(titles(renderer.container)).toHaveLength(5)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(renderer.container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')

    act(() => { button.click() })
    expect(titles(renderer.container)).toEqual(['来源1', '来源2'])
    renderer.unmount()
  })

  it('来源不超过两条时不出现折叠按钮', () => {
    const renderer = renderDom(<WebSearchCard output={output(2)} />)
    expect(titles(renderer.container)).toHaveLength(2)
    expect(renderer.container.querySelector('.web-search-card__more')).toBeNull()
    renderer.unmount()
  })
})
