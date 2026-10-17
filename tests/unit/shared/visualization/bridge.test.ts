import { describe, expect, it } from 'vitest'
import {
  createHostBridgeEnvelope,
  MAX_VISUALIZATION_ERROR_CHARS,
  parseArtifactBridgeMessage,
  VISUALIZATION_BRIDGE_VERSION
} from '../../../../src/shared/visualization'

function envelope(kind: string, payload: unknown): Record<string, unknown> {
  return { v: VISUALIZATION_BRIDGE_VERSION, kind, id: 'a1', seq: 1, payload }
}

const cyclic: Record<string, unknown> = {}
cyclic.self = cyclic

describe('产物消息解析', () => {
  it('合法消息按类型解析并归一化', () => {
    expect(parseArtifactBridgeMessage(envelope('ready', { status: 'missing', initialHeight: 120 }))).toEqual({
      kind: 'ready',
      payload: { status: 'missing', initialHeight: 120 }
    })
    expect(parseArtifactBridgeMessage(envelope('resize', { height: 0 }))).toEqual({ kind: 'resize', payload: { height: 0 } })
    expect(parseArtifactBridgeMessage(envelope('event', { name: 'node.select', data: { id: 3 } }))).toEqual({
      kind: 'event',
      payload: { name: 'node.select', data: { id: 3 } }
    })
    expect(parseArtifactBridgeMessage(envelope('error', { message: '  boom  ' }))).toEqual({
      kind: 'error',
      payload: { message: 'boom' }
    })
    expect(parseArtifactBridgeMessage(envelope('open-external', { url: 'https://example.com/a b' }))).toEqual({
      kind: 'open-external',
      payload: { url: 'https://example.com/a%20b' }
    })
  })

  it('错误信息截断到上限', () => {
    const message = parseArtifactBridgeMessage(envelope('error', { message: 'x'.repeat(MAX_VISUALIZATION_ERROR_CHARS * 2) }))
    expect(message?.kind === 'error' && message.payload.message.length).toBe(MAX_VISUALIZATION_ERROR_CHARS)
  })

  it.each([
    ['版本不符', { ...envelope('resize', { height: 1 }), v: 2 }],
    ['缺少序号', { ...envelope('resize', { height: 1 }), seq: undefined }],
    ['未知类型', envelope('navigate', { url: 'https://example.com' })],
    ['载荷不是对象', envelope('resize', 5)],
    ['高度非有限', envelope('resize', { height: Number.POSITIVE_INFINITY })],
    ['高度为负', envelope('resize', { height: -1 })],
    ['未知文档状态', envelope('ready', { status: 'pending', initialHeight: 1 })],
    ['事件名含空格', envelope('event', { name: 'node select', data: null })],
    ['事件名过长', envelope('event', { name: 'x'.repeat(65), data: null })],
    ['事件数据过大', envelope('event', { name: 'big', data: 'x'.repeat(4001) })],
    ['事件数据不可序列化', envelope('event', { name: 'cyclic', data: cyclic })],
    ['空错误', envelope('error', { message: '   ' })],
    ['脚本外链', envelope('open-external', { url: 'javascript:alert(1)' })],
    ['本地文件外链', envelope('open-external', { url: 'file:///C:/Windows/win.ini' })],
    ['外链携带凭据', envelope('open-external', { url: 'https://user:pw@example.com' })],
    ['外链过长', envelope('open-external', { url: `https://example.com/${'x'.repeat(2100)}` })]
  ])('丢弃不可信消息：%s', (_label, data) => {
    expect(parseArtifactBridgeMessage(data)).toBeNull()
  })
})

describe('宿主消息信封', () => {
  it('携带协议版本与递增序号', () => {
    expect(createHostBridgeEnvelope({ kind: 'motion-scale', payload: { motionScale: 4 } }, 3)).toEqual({
      v: VISUALIZATION_BRIDGE_VERSION,
      kind: 'motion-scale',
      id: 'h3',
      seq: 3,
      payload: { motionScale: 4 }
    })
  })
})
