// @vitest-environment jsdom
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildVisualizationBridgeScript,
  type VisualizationBridgeConfig
} from '../../../../src/runtime/visualizations/visualizationBridgeScript'
import {
  createHostBridgeEnvelope,
  parseArtifactBridgeMessage,
  VISUALIZATION_THEME_TOKENS,
  type ArtifactBridgeMessage,
  type HostBridgeMessage,
  type VisualizationTheme
} from '../../../../src/shared/visualization'

interface NovaApi {
  readonly theme: VisualizationTheme | null
  readonly motionScale: number
  emit(name: unknown, data?: unknown): boolean
  openExternal(url: unknown): boolean
  on(type: string, listener: (value: unknown) => void): () => void
}

type FrameWindow = Window & typeof globalThis & { nova: NovaApi }

function theme(scheme: VisualizationTheme['scheme'], color: string): VisualizationTheme {
  return {
    scheme,
    tokens: Object.fromEntries(VISUALIZATION_THEME_TOKENS.map(name => [name, color])) as VisualizationTheme['tokens']
  }
}

function config(overrides: Partial<VisualizationBridgeConfig> = {}): VisualizationBridgeConfig {
  return { status: 'ok', theme: theme('light', '#111111'), motionScale: 1, maxHeight: 720, ...overrides }
}

/** 宿主校验会丢弃的消息：桥两端协议一旦不一致就会出现在这里 */
const rejected: unknown[] = []

/**
 * 在同源 iframe 里运行桥脚本：父窗口即宿主，收到的消息按宿主同一套校验解析。
 * vitest 的全局 window 是注入了 jsdom 属性的 Node 全局对象，帧的 parent 是真正的 jsdom 窗口。
 * about:blank 会继承父文档的基址，这里按真实帧把基址设为快照地址。
 */
function mountFrame(bridgeConfig = config()) {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const frame = iframe.contentWindow as FrameWindow
  const base = frame.document.createElement('base')
  base.href = `nova-viz://snapshot/s1/${'c'.repeat(64)}.html`
  frame.document.head.appendChild(base)
  const host = frame.parent
  const received: ArtifactBridgeMessage[] = []
  vi.spyOn(host, 'postMessage').mockImplementation((data: unknown) => {
    const message = parseArtifactBridgeMessage(data)
    if (message) received.push(message)
    else rejected.push(data)
  })
  frame.eval(buildVisualizationBridgeScript(bridgeConfig))
  let seq = 0
  const send = (message: HostBridgeMessage): void => {
    seq += 1
    frame.dispatchEvent(new frame.MessageEvent('message', { data: createHostBridgeEnvelope(message, seq), source: host }))
  }
  const themeCss = (): string => frame.document.head.querySelector('style')?.textContent ?? ''
  return { frame, received, send, themeCss }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  expect(rejected.splice(0)).toEqual([])
})

describe('帧内桥运行时', () => {
  it('启动即上报 ready；宿主 ack 后套用新主题与倍率并强制上报高度', () => {
    const { frame, received, send, themeCss } = mountFrame(config({ status: 'missing' }))
    expect(received[0]).toEqual({ kind: 'ready', payload: { status: 'missing', initialHeight: 0 } })
    expect(themeCss()).toContain('--viz-bg:#111111')
    expect(themeCss()).toContain('color-scheme:light')

    const onTheme = vi.fn()
    frame.nova.on('theme', onTheme)
    send({ kind: 'ack', payload: { theme: theme('dark', '#222222'), motionScale: 4 } })

    expect(themeCss()).toContain('--viz-bg:#222222')
    expect(themeCss()).toContain('color-scheme:dark')
    expect(onTheme).toHaveBeenCalledTimes(1)
    expect(frame.nova.theme?.scheme).toBe('dark')
    expect(received.at(-1)?.kind).toBe('resize')
    // 读取倍率说明作者用脚本驱动动画：宿主据此提供慢放
    expect(frame.nova.motionScale).toBe(4)
    expect(received.at(-1)?.kind).toBe('animated')
  })

  it('只接受来自宿主窗口的消息', () => {
    const { frame, send, themeCss } = mountFrame()
    frame.dispatchEvent(
      new frame.MessageEvent('message', {
        data: createHostBridgeEnvelope({ kind: 'theme-change', payload: { theme: theme('dark', '#333333') } }, 1),
        source: frame
      })
    )
    expect(themeCss()).toContain('--viz-bg:#111111')
    send({ kind: 'theme-change', payload: { theme: theme('dark', '#333333') } })
    expect(themeCss()).toContain('--viz-bg:#333333')
  })

  it('emit 校验事件名与数据体积，合法事件原样上报', () => {
    const { frame, received } = mountFrame()
    expect(frame.nova.emit('node.select', { id: 2 })).toBe(true)
    expect(received.at(-1)).toEqual({ kind: 'event', payload: { name: 'node.select', data: { id: 2 } } })

    expect(frame.nova.emit('node select', 1)).toBe(false)
    expect(received.at(-1)?.kind).toBe('error')
    expect(frame.nova.emit('big', 'x'.repeat(5000))).toBe(false)
    expect(received.filter(message => message.kind === 'event')).toHaveLength(1)
  })

  it('http(s) 外链与 window.open 交给宿主，页内锚点与其他协议不外发', () => {
    const { frame, received } = mountFrame()
    const doc = frame.document
    doc.body.innerHTML = '<a id="out" href="https://example.com/docs">docs</a><a id="in" href="#part">part</a>'
    // 窗口级冒泡监听晚于桥的 document 监听：记下桥是否拦截，再阻止 jsdom 尝试导航
    const preventedByBridge: boolean[] = []
    frame.addEventListener('click', event => {
      preventedByBridge.push(event.defaultPrevented)
      event.preventDefault()
    })
    const click = (id: string): void => {
      doc.getElementById(id)!.dispatchEvent(new frame.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    }

    click('out')
    expect(received.at(-1)).toEqual({ kind: 'open-external', payload: { url: 'https://example.com/docs' } })
    click('in')
    expect(preventedByBridge).toEqual([true, false])
    expect(received.filter(message => message.kind === 'open-external')).toHaveLength(1)

    expect(frame.open('https://example.com/popup')).toBeNull()
    expect(received.at(-1)).toEqual({ kind: 'open-external', payload: { url: 'https://example.com/popup' } })
    expect(frame.nova.openExternal('javascript:alert(1)')).toBe(false)
    expect(received.at(-1)?.kind).toBe('error')
  })

  it('运行错误带行列号上报，ResizeObserver 良性告警被忽略', () => {
    const { frame, received } = mountFrame()
    frame.dispatchEvent(new frame.ErrorEvent('error', { message: 'TypeError: x is undefined', lineno: 3, colno: 9 }))
    frame.dispatchEvent(new frame.ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }))
    expect(received.filter(message => message.kind === 'error')).toEqual([
      { kind: 'error', payload: { message: 'TypeError: x is undefined (3:9)' } }
    ])
  })
})

describe('独立打开的导出文件', () => {
  it('不向任何窗口发消息，仍提供主题与 nova API', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
    const standalone = dom.window as unknown as FrameWindow
    const postMessage = vi.spyOn(standalone, 'postMessage')
    vi.spyOn(standalone.console, 'info').mockImplementation(() => {})

    standalone.eval(buildVisualizationBridgeScript(config({ theme: theme('dark', '#444444') })))

    expect(standalone.nova.theme?.tokens.bg).toBe('#444444')
    expect(standalone.document.head.querySelector('style')?.textContent).toContain('--viz-bg:#444444')
    expect(standalone.nova.emit('pick', { id: 1 })).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
    dom.window.close()
  })
})
