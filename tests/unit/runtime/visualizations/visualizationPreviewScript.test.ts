// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildVisualizationPreviewScript } from '../../../../src/runtime/visualizations/visualizationPreviewScript'
import {
  createHostBridgeEnvelope,
  VISUALIZATION_BRIDGE_VERSION
} from '../../../../src/shared/visualization'

type FrameWindow = Window & typeof globalThis

/** 在同源 iframe 里运行接收脚本：event.source 指向父窗口，与真实预览帧的宿主一致 */
function mountFrame() {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const frame = iframe.contentWindow as FrameWindow
  const host = frame.parent
  let seq = 0
  const push = (html: string): void => {
    seq += 1
    frame.dispatchEvent(
      new frame.MessageEvent('message', {
        data: createHostBridgeEnvelope({ kind: 'preview-html', payload: { html } }, seq),
        source: host
      })
    )
  }
  const sendRaw = (data: unknown, source: MessageEventSource | null = host): void => {
    frame.dispatchEvent(new frame.MessageEvent('message', { data, source }))
  }
  frame.eval(buildVisualizationPreviewScript())
  return { frame, host, push, sendRaw }
}

describe('帧内预览接收脚本', () => {
  it('追加推送时已有节点保持同一实例，末尾新节点被挂上', () => {
    const { frame, push } = mountFrame()
    push('<div><p>one</p></div>')
    const div = frame.document.body.querySelector('div')
    const first = frame.document.querySelector('p')

    push('<div><p>one</p><p>two</p></div>')

    expect(frame.document.body.querySelector('div')).toBe(div)
    expect(frame.document.querySelectorAll('p')[0]).toBe(first)
    expect(frame.document.querySelectorAll('p')[1]?.textContent).toBe('two')
  })

  it('同名元素只更新文本与属性，多出来的旧节点被移除', () => {
    const { frame, push } = mountFrame()
    push('<p class="a">one</p><p>two</p>')
    const first = frame.document.querySelector('p')

    push('<p class="b">changed</p>')

    expect(frame.document.querySelector('p')).toBe(first)
    expect(first?.getAttribute('class')).toBe('b')
    expect(first?.textContent).toBe('changed')
    expect(frame.document.querySelectorAll('p')).toHaveLength(1)
  })

  it('style 文本汇总进帧内专用样式元素，内容不变时不重写', () => {
    const { frame, push } = mountFrame()
    push('<style>.a{color:red}</style><p>x</p>')
    const styleTag = frame.document.head.querySelector('style')
    expect(styleTag?.textContent).toBe('.a{color:red}')

    push('<style>.a{color:red}.b{color:blue}</style><p>x</p>')
    expect(frame.document.head.querySelector('style')).toBe(styleTag)
    expect(styleTag?.textContent).toBe('.a{color:red}.b{color:blue}')
    // body 里的 style 已被剔除，不会作为内容节点同步进来
    expect(frame.document.body.querySelector('style')).toBeNull()
  })

  it('script、iframe 等标签不进入预览 DOM', () => {
    const { frame, push } = mountFrame()
    push('<p>ok</p><script>globalThis.__x = 1</script><iframe src="https://evil.example"></iframe><meta charset="utf-8">')
    expect(frame.document.body.querySelector('script, iframe, meta')).toBeNull()
    expect(frame.document.body.textContent).toContain('ok')
    expect((frame as unknown as { __x?: unknown }).__x).toBeUndefined()
  })

  it('只接受宿主窗口的 preview-html 消息', () => {
    const { frame, sendRaw } = mountFrame()
    const envelope = createHostBridgeEnvelope({ kind: 'preview-html', payload: { html: '<p>x</p>' } }, 1)
    // 来源是帧自己而非父窗口
    sendRaw(envelope, frame)
    // 版本不符
    sendRaw({ ...envelope, v: VISUALIZATION_BRIDGE_VERSION + 1 })
    // 类型不符
    sendRaw({ ...envelope, kind: 'ack' })
    expect(frame.document.body.childNodes).toHaveLength(0)
  })

  it('畸形输入不抛异常，之后的正常推送仍生效', () => {
    const { frame, sendRaw, push } = mountFrame()
    expect(() => {
      sendRaw(createHostBridgeEnvelope({ kind: 'preview-html', payload: {} as { html: string } }, 1))
      sendRaw({ v: VISUALIZATION_BRIDGE_VERSION, kind: 'preview-html', payload: { html: 42 } })
      sendRaw({ v: VISUALIZATION_BRIDGE_VERSION, kind: 'preview-html', payload: null })
      sendRaw(null)
      sendRaw('preview-html')
      sendRaw({ v: VISUALIZATION_BRIDGE_VERSION, kind: 'preview-html', payload: { html: '<<<>>><p' } })
    }).not.toThrow()

    push('<p>alive</p>')
    expect(frame.document.body.textContent).toContain('alive')
  })
})
