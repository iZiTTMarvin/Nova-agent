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
