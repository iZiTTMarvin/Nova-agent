// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisualizationCard } from '../../../../src/renderer/features/visualization/VisualizationCard'
import {
  buildVisualizationUri,
  formatVisualizationResult,
  parseVisualizationFrameInit,
  VISUALIZATION_BRIDGE_VERSION,
  VISUALIZATION_MAX_INLINE_HEIGHT,
  VISUALIZATION_SLOW_MOTION_SCALE
} from '../../../../src/shared/visualization'
import { act, renderDom, waitFor, type DomRenderResult } from '../../../unit/renderer/renderDom'

const mocks = vi.hoisted(() => ({ submit: vi.fn(async (_text: string) => {}) }))

vi.mock('../../../../src/renderer/features/visualization/visualizationMessages', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../src/renderer/features/visualization/visualizationMessages')>()),
  submitVisualizationMessage: mocks.submit
}))

let view: DomRenderResult | null = null
let snapshotCount = 0
let seq = 0

function presented(title: string): { uri: string; result: string } {
  snapshotCount += 1
  const uri = buildVisualizationUri({ sessionId: 'session-1', sha256: snapshotCount.toString(16).padStart(64, '0') })
  return { uri, result: formatVisualizationResult({ title, uri, bytes: 512 }) }
}

function mount(element: React.ReactElement): HTMLElement {
  view = renderDom(element)
  return view.container
}

function mountPresented(title: string): { container: HTMLElement; frame: HTMLIFrameElement; uri: string } {
  const { uri, result } = presented(title)
  const container = mount(<VisualizationCard status="success" title={title} result={result} />)
  return { container, frame: frameIn(container), uri }
}

function frameIn(root: ParentNode): HTMLIFrameElement {
  const frame = root.querySelector<HTMLIFrameElement>('[data-testid="visualization-frame"]')
  if (!frame) throw new Error('未挂载可视化帧')
  return frame
}

function stateOf(root: ParentNode): string | null {
  return root.querySelector('[data-testid="visualization-card"]')?.getAttribute('data-state') ?? null
}

function button(root: ParentNode, label: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

function textButton(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))
}

function send(source: unknown, kind: string, payload: unknown): void {
  seq += 1
  const event = new MessageEvent('message', {
    data: { v: VISUALIZATION_BRIDGE_VERSION, kind, id: `a${seq}`, seq, payload },
    source: source as Window | null
  })
  act(() => {
    window.dispatchEvent(event)
  })
}

function ready(frame: HTMLIFrameElement, initialHeight = 200): void {
  send(frame.contentWindow, 'ready', { status: 'ok', initialHeight })
}

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive, hasBeenActive: isActive }
  })
}

beforeAll(() => {
  // 弹窗依赖的浏览器能力，jsdom 未实现
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })
  const escapeCss = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  if (typeof CSS === 'undefined') {
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: escapeCss } })
  } else {
    Object.defineProperty(CSS, 'escape', { configurable: true, value: escapeCss })
  }
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true
    }
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false
    }
  })
})

beforeEach(() => {
  mocks.submit.mockClear()
  setUserActivation(false)
})

afterEach(() => {
  view?.unmount()
  view = null
  Reflect.deleteProperty(navigator, 'userActivation')
})

describe('VisualizationCard', () => {
  it('生成中按已到达字符数显示进度；展示后挂载只允许脚本的沙箱帧，并随 src 下发首帧状态', () => {
    const container = mount(<VisualizationCard status="running" title="请求链路" streamedChars={2345} />)
    const card = container.querySelector('[data-testid="visualization-card"]')!
    expect(card.getAttribute('data-state')).toBe('generating')
    expect(card.getAttribute('aria-busy')).toBe('true')
    expect(card.textContent).toContain('正在生成 · 2.3k 字符')
    expect(container.querySelector('iframe')).toBeNull()

    const { uri, result } = presented('请求链路')
    view!.render(<VisualizationCard status="success" title="请求链路" result={result} />)
    const frame = frameIn(container)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.src.startsWith(`${uri}?`)).toBe(true)
    expect(parseVisualizationFrameInit(frame.src)).toMatchObject({
      motionScale: 1,
      maxHeight: VISUALIZATION_MAX_INLINE_HEIGHT
    })
    expect(frame.style.height).toBe('160px')
    expect(stateOf(container)).toBe('loading')
    expect(button(container, '展开')).toBeNull()
  })

  it('结果无法解析时显示失效状态，不挂载帧', () => {
    const container = mount(
      <VisualizationCard status="success" title="坏结果" result={'{"presented":true,"title":"x","uri":"file:///etc/passwd","bytes":1}'} />
    )
    expect(stateOf(container)).toBe('invalid')
    expect(container.textContent).toContain('可视化结果无法解析')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('消息按来源窗口分发给各自的卡片：握手后回 ack，按上报高度定高并开放操作', () => {
    const first = presented('甲')
    const second = presented('乙')
    const container = mount(
      <>
        <VisualizationCard status="success" title="甲" result={first.result} />
        <VisualizationCard status="success" title="乙" result={second.result} />
      </>
    )
    const [cardA, cardB] = container.querySelectorAll<HTMLElement>('[data-testid="visualization-card"]')
    const frameA = frameIn(cardA)
    const frameB = frameIn(cardB)
    const postedA = vi.spyOn(frameA.contentWindow!, 'postMessage')

    send(window, 'ready', { status: 'ok', initialHeight: 300 })
    send(null, 'ready', { status: 'ok', initialHeight: 300 })
    ready(frameB, 260)
    expect(cardA.getAttribute('data-state')).toBe('loading')
    expect(cardB.getAttribute('data-state')).toBe('ok')
    expect(postedA).not.toHaveBeenCalled()

    ready(frameA, 300.2)
    expect(cardA.getAttribute('data-state')).toBe('ok')
    expect(frameA.style.height).toBe('301px')
    expect(frameA.classList.contains('visualization-frame--ready')).toBe(true)
    expect(postedA).toHaveBeenCalledTimes(1)
    expect(postedA.mock.calls[0][0]).toMatchObject({ v: VISUALIZATION_BRIDGE_VERSION, kind: 'ack', payload: { motionScale: 1 } })
    expect(postedA.mock.calls[0][1]).toBe('*')
    expect(button(cardA, '展开')).not.toBeNull()
    expect(button(cardA, '导出 HTML')).not.toBeNull()
    expect(button(cardA, '慢放')).toBeNull()

    send(frameA.contentWindow, 'resize', { height: 5000 })
    expect(frameA.style.height).toBe(`${VISUALIZATION_MAX_INLINE_HEIGHT}px`)
    expect(frameB.style.height).toBe('260px')
  })

  it('交互回传要求焦点在本帧且处于用户激活期，同一操作内不连发', () => {
    const { frame } = mountPresented('漏斗')
    ready(frame)

    send(frame.contentWindow, 'event', { name: 'select', data: { stage: 2 } })
    setUserActivation(true)
    send(frame.contentWindow, 'event', { name: 'select', data: { stage: 2 } })
    expect(mocks.submit).not.toHaveBeenCalled()

    act(() => frame.focus())
    expect(document.activeElement).toBe(frame)
    send(frame.contentWindow, 'event', { name: 'select', data: { stage: 2 } })
    send(frame.contentWindow, 'event', { name: 'select', data: { stage: 3 } })
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    expect(mocks.submit).toHaveBeenCalledWith('【可视化】漏斗 · select\n{"stage":2}')
  })

  it('运行错误去重汇总到卡片底部，请求修复只提交一次', () => {
    const { container, frame } = mountPresented('图')
    ready(frame)
    send(frame.contentWindow, 'error', { message: 'TypeError: x is undefined (3:7)' })
    send(frame.contentWindow, 'error', { message: 'TypeError: x is undefined (3:7)' })
    send(frame.contentWindow, 'error', { message: 'RangeError: bad' })

    const footer = container.querySelector('[data-testid="visualization-errors"]')!
    expect(footer.textContent).toContain('TypeError: x is undefined (3:7)（另有 1 条）')
    act(() => textButton(footer, '让 Nova 修复')!.click())
    expect(mocks.submit).toHaveBeenCalledTimes(1)
    expect(mocks.submit).toHaveBeenCalledWith(
      '【可视化报错】图\nTypeError: x is undefined (3:7)\nRangeError: bad\n请修复后重新展示。'
    )
    const requested = textButton(footer, '已请求修复')!
    expect(requested.disabled).toBe(true)
  })

  it('产物出现动画后才提供慢放，切换时经桥下发倍率而不重载帧', () => {
    const { container, frame } = mountPresented('动画')
    const src = frame.src
    ready(frame)
    const posted = vi.spyOn(frame.contentWindow!, 'postMessage')
    expect(button(container, '慢放')).toBeNull()

    send(frame.contentWindow, 'animated', {})
    const slow = button(container, '慢放')!
    expect(slow.getAttribute('aria-pressed')).toBe('false')
    act(() => slow.click())
    expect(posted).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'motion-scale', payload: { motionScale: VISUALIZATION_SLOW_MOTION_SCALE } }),
      '*'
    )
    expect(frameIn(container)).toBe(frame)
    expect(frame.src).toBe(src)

    const restore = button(container, '恢复正常速度')!
    expect(restore.getAttribute('aria-pressed')).toBe('true')
    act(() => restore.click())
    expect(posted).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'motion-scale', payload: { motionScale: 1 } }),
      '*'
    )
  })

  it('握手超时后可重试，重试换用全新的帧', () => {
    vi.useFakeTimers()
    try {
      const { container, frame } = mountPresented('超时')
      act(() => {
        vi.advanceTimersByTime(15_000)
      })
      expect(stateOf(container)).toBe('timeout')
      expect(container.querySelector('iframe')).toBeNull()

      act(() => textButton(container, '重试')!.click())
      const retried = frameIn(container)
      expect(retried).not.toBe(frame)
      expect(stateOf(container)).toBe('loading')
      ready(retried)
      expect(stateOf(container)).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })

  it('展开视图挂载独立帧，其报错同样汇总到卡片；关闭后内联帧仍在', () => {
    const { container, frame } = mountPresented('全景')
    ready(frame)
    act(() => button(container, '展开')!.click())

    const frames = [...document.querySelectorAll<HTMLIFrameElement>('[data-testid="visualization-frame"]')]
    expect(frames).toHaveLength(2)
    expect(frames[0]).toBe(frame)
    const expanded = frames[1]
    expect(expanded.src).not.toBe(frame.src)
    send(expanded.contentWindow, 'ready', { status: 'ok', initialHeight: 400 })
    send(expanded.contentWindow, 'error', { message: 'ReferenceError: d3 is not defined' })
    expect(container.querySelector('[data-testid="visualization-errors"]')?.textContent).toContain(
      'ReferenceError: d3 is not defined'
    )

    act(() => button(document, '关闭')!.click())
    expect(document.querySelectorAll('[data-testid="visualization-frame"]')).toHaveLength(1)
    expect(frameIn(container)).toBe(frame)
  })

  it('内容高于内联高度上限时提示去展开视图看完整内容', () => {
    const { container, frame } = mountPresented('长图')
    ready(frame)
    expect(container.querySelector('[data-testid="visualization-overflow"]')).toBeNull()

    send(frame.contentWindow, 'resize', { height: VISUALIZATION_MAX_INLINE_HEIGHT + 400 })
    const footer = container.querySelector('[data-testid="visualization-overflow"]')!
    expect(footer.textContent).toContain('可在卡片内滚动查看')
    expect(frame.style.height).toBe(`${VISUALIZATION_MAX_INLINE_HEIGHT}px`)

    act(() => textButton(footer, '展开查看')!.click())
    expect(document.querySelectorAll('[data-testid="visualization-frame"]')).toHaveLength(2)
  })

  it('导出交给主进程，并以状态提示反馈结果', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'saved', filePath: 'C:/out/图.html' })
    Object.assign(window, { api: { invoke } })
    const { container, frame, uri } = mountPresented('导出')
    ready(frame)

    await act(async () => {
      button(container, '导出 HTML')!.click()
    })
    expect(invoke).toHaveBeenCalledWith('visualization:export', {
      uri,
      title: '导出',
      theme: expect.objectContaining({ scheme: expect.stringMatching(/^(light|dark)$/) })
    })
    await waitFor(() => container.querySelector('.visualization-card__notice')?.textContent === '已导出')
  })
})
