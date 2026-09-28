import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 19 requires this flag for act() calls that flush React DOM updates.
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })
  })
}

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: (): CanvasRenderingContext2D => ({
      beginPath: () => {},
      arc: () => {},
      stroke: () => {},
      lineCap: 'round',
      lineWidth: 0,
      strokeStyle: '',
      globalAlpha: 1
    } as unknown as CanvasRenderingContext2D)
  })
}

if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {}
  })
}

export interface DomRenderResult {
  container: HTMLDivElement
  root: Root
  render: (element: React.ReactNode) => void
  unmount: () => void
}

export function renderDom(element: React.ReactNode): DomRenderResult {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(element)
  })

  return {
    container,
    root,
    render(nextElement) {
      act(() => {
        root.render(nextElement)
      })
    },
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
  }
}

export { act }

/**
 * 等待条件成立，期间反复 flush 微任务与 React 更新。
 *
 * 懒加载组件（React.lazy）在测试里要经过真实的动态 import 解析，
 * 固定次数的 await Promise.resolve() 不足以等它落地。用它代替手写微任务计数，
 * 断言强度不变但不再依赖加载时序的快慢。
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）：条件始终不成立`)
    }
    await act(async () => {
      await Promise.resolve()
    })
  }
}
