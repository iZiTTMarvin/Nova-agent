// @vitest-environment jsdom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('TurnProcessCollapsible 收起定位', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function setup() {
    const frames: Array<(now: number) => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0 })
    const realComputed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = realComputed(el)
      if (el.classList.contains('turn-process-collapsible')) {
        return { ...style, transitionDuration: '240ms' } as CSSStyleDeclaration
      }
      if (el.classList.contains('scroller')) return { overflowY: 'auto' } as CSSStyleDeclaration
      return style
    })
    const scroller = document.createElement('div')
    scroller.className = 'scroller'
    const header = document.createElement('div')
    scroller.appendChild(header)
    document.body.appendChild(scroller)
    let headerTop = 100
    header.getBoundingClientRect = () => ({ top: headerTop } as DOMRect)
    const headerRef = { current: header }
    const mountInto = (open: boolean) => (
      <TurnProcessCollapsible open={open} pinHeaderRef={headerRef}>
        <div>inner</div>
      </TurnProcessCollapsible>
    )
    return {
      frames, scroller, headerRef,
      moveHeader: (top: number) => { headerTop = top },
      mountInto
    }
  }

  it('收起动画期间钉住折叠头；用户滚轮后不再抢夺视口', () => {
    const env = setup()
    const renderer = renderDom(env.mountInto(true))
    env.scroller.appendChild(renderer.container)
    renderer.render(env.mountInto(false))
    expect(env.frames).toHaveLength(1)

    env.moveHeader(130)
    env.frames.shift()?.(performance.now())
    expect(env.scroller.scrollTop).toBe(30)
    expect(env.frames).toHaveLength(1)

    env.scroller.dispatchEvent(new Event('wheel'))
    const before = env.scroller.scrollTop
    env.moveHeader(200)
    env.frames.splice(0).forEach(frame => frame(performance.now()))
    expect(env.scroller.scrollTop).toBe(before)
    renderer.unmount()
    env.scroller.remove()
  })
})
