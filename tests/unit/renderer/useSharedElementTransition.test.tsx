// @vitest-environment jsdom

import React, { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeObjectFitInset,
  getElementBorderRadius,
  useSharedElementTransition,
  type DocumentWithViewTransition
} from '../../../src/renderer/hooks/useSharedElementTransition'
import { act, renderDom } from './renderDom'

function Harness({
  isOpen,
  originEl
}: {
  isOpen: boolean
  originEl?: HTMLElement | null
}) {
  const originRef = useRef<HTMLElement | null>(originEl ?? null)
  const { isMounted, setTarget } = useSharedElementTransition({
    isOpen,
    originRef,
    originElement: originEl
  })
  return (
    <div>
      {isMounted && (
        <div
          ref={setTarget}
          data-testid="preview-target"
          style={{ borderRadius: '16px', overflow: 'hidden' }}
        />
      )}
    </div>
  )
}

describe('useSharedElementTransition', () => {
  afterEach(() => {
    const doc = document as unknown as DocumentWithViewTransition
    delete doc.startViewTransition
    document.documentElement.style.removeProperty('--vt-image-preview-source-radius')
    document.documentElement.style.removeProperty('--vt-image-preview-target-radius')
    document.documentElement.style.removeProperty('--vt-image-preview-source-inset')
  })

  it('在不支持 startViewTransition 的环境中直接同步挂载与卸载', () => {
    const renderer = renderDom(<Harness isOpen={false} />)
    expect(renderer.container.querySelector('[data-testid="preview-target"]')).toBeNull()

    renderer.render(<Harness isOpen={true} />)
    expect(renderer.container.querySelector('[data-testid="preview-target"]')).not.toBeNull()

    renderer.render(<Harness isOpen={false} />)
    expect(renderer.container.querySelector('[data-testid="preview-target"]')).toBeNull()
    renderer.unmount()
  })

  it('支持 startViewTransition 时驱动源/目标 view-transition-name 并在结束后清理', async () => {
    let resolveReady: () => void = () => {}
    let resolveFinished: () => void = () => {}

    const doc = document as unknown as DocumentWithViewTransition
    doc.startViewTransition = vi.fn((cb: () => void) => {
      cb()
      const ready = new Promise<void>(r => {
        resolveReady = r
      })
      const finished = new Promise<void>(r => {
        resolveFinished = r
      })
      return { ready, finished }
    })

    const originImg = document.createElement('img')
    originImg.style.borderRadius = '10px'
    document.body.appendChild(originImg)

    const renderer = renderDom(<Harness isOpen={false} originEl={originImg} />)
    renderer.render(<Harness isOpen={true} originEl={originImg} />)

    expect(doc.startViewTransition).toHaveBeenCalledTimes(1)
    expect(originImg.style.getPropertyValue('view-transition-name')).toBe('chat-image-preview')
    expect(
      document.documentElement.style.getPropertyValue('--vt-image-preview-source-radius')
    ).toBe('10px')

    const target = renderer.container.querySelector<HTMLElement>('[data-testid="preview-target"]')!
    expect(target).not.toBeNull()

    await act(async () => {
      resolveReady()
      await Promise.resolve()
    })
    expect(originImg.style.getPropertyValue('view-transition-name')).toBe('')
    expect(target.style.getPropertyValue('view-transition-name')).toBe('chat-image-preview')

    await act(async () => {
      resolveFinished()
      await Promise.resolve()
    })
    expect(target.style.getPropertyValue('view-transition-name')).toBe('')
    expect(
      document.documentElement.style.getPropertyValue('--vt-image-preview-source-radius')
    ).toBe('')

    renderer.unmount()
    originImg.remove()
  })

  it('辅助函数：提取圆角与计算 contain 内切裁剪', () => {
    const wrapper = document.createElement('div')
    wrapper.style.overflow = 'hidden'
    wrapper.style.borderRadius = '12px'
    const child = document.createElement('span')
    wrapper.appendChild(child)
    document.body.appendChild(wrapper)

    expect(getElementBorderRadius(child)).toBe('12px')
    wrapper.remove()

    const img = document.createElement('img')
    Object.defineProperty(img, 'naturalWidth', { value: 200 })
    Object.defineProperty(img, 'naturalHeight', { value: 100 })
    img.style.objectFit = 'contain'
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    document.body.appendChild(img)
    expect(computeObjectFitInset(img)).toBe('25% 0% 25% 0%')
    img.remove()
  })
})
