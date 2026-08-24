// @vitest-environment jsdom

import React from 'react'
import { describe, expect, it } from 'vitest'
import { TurnProcessCollapsible } from '../../../src/renderer/features/chat/TurnProcessCollapsible'
import { renderDom } from './renderDom'

describe('TurnProcessCollapsible', () => {
  it('关闭时不挂载内容', () => {
    const renderer = renderDom(
      <TurnProcessCollapsible open={false}>
        <div data-testid="body">inner</div>
      </TurnProcessCollapsible>
    )
    expect(renderer.container.querySelector('[data-testid="body"]')).toBeNull()
    renderer.unmount()
  })

  it('打开后挂载；再关闭且无过渡时立即卸载', () => {
    const renderer = renderDom(
      <TurnProcessCollapsible open>
        <div data-testid="body">inner</div>
      </TurnProcessCollapsible>
    )
    expect(renderer.container.querySelector('[data-testid="body"]')).not.toBeNull()

    renderer.render(
      <TurnProcessCollapsible open={false}>
        <div data-testid="body">inner</div>
      </TurnProcessCollapsible>
    )
    expect(renderer.container.querySelector('[data-testid="body"]')).toBeNull()
    renderer.unmount()
  })

  it('reducedMotion 关闭时立即卸载', () => {
    const renderer = renderDom(
      <TurnProcessCollapsible open reducedMotion>
        <div data-testid="body">inner</div>
      </TurnProcessCollapsible>
    )
    renderer.render(
      <TurnProcessCollapsible open={false} reducedMotion>
        <div data-testid="body">inner</div>
      </TurnProcessCollapsible>
    )
    expect(renderer.container.querySelector('[data-testid="body"]')).toBeNull()
    renderer.unmount()
  })
})
