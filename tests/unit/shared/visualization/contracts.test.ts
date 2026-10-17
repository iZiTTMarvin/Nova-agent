import { describe, expect, it } from 'vitest'
import {
  buildVisualizationFrameSrc,
  buildVisualizationUri,
  formatVisualizationResult,
  parseVisualizationFrameInit,
  parseVisualizationResult,
  parseVisualizationTheme,
  parseVisualizationUri,
  VISUALIZATION_THEME_TOKENS,
  type VisualizationTheme
} from '../../../../src/shared/visualization'

const SHA = 'a'.repeat(64)

function theme(overrides: Partial<VisualizationTheme['tokens']> = {}): VisualizationTheme {
  const tokens = Object.fromEntries(VISUALIZATION_THEME_TOKENS.map(name => [name, '#123456'])) as VisualizationTheme['tokens']
  return { scheme: 'dark', tokens: { ...tokens, ...overrides } }
}

describe('可视化快照地址', () => {
  it('会话 ID 的大小写经地址往返不变，帧初始化参数不参与寻址', () => {
    const uri = buildVisualizationUri({ sessionId: 'Sess_AbC-1', sha256: SHA })
    expect(parseVisualizationUri(uri)).toEqual({ sessionId: 'Sess_AbC-1', sha256: SHA })
    const src = buildVisualizationFrameSrc(uri, { theme: theme(), motionScale: 1, maxHeight: 720 })
    expect(parseVisualizationUri(src)).toEqual({ sessionId: 'Sess_AbC-1', sha256: SHA })
  })

  it.each([
    ['其他 host', `nova-viz://other/s1/${SHA}.html`],
    ['大写摘要', `nova-viz://snapshot/s1/${SHA.toUpperCase()}.html`],
    ['多级路径', `nova-viz://snapshot/s1/x/${SHA}.html`],
    ['编码分隔符', `nova-viz://snapshot/s1%2F..%2Fx/${SHA}.html`],
    ['携带凭据', `nova-viz://user:pw@snapshot/s1/${SHA}.html`],
    ['携带端口', `nova-viz://snapshot:8080/s1/${SHA}.html`],
    ['其他协议', `https://snapshot/s1/${SHA}.html`]
  ])('拒绝%s', (_label, uri) => {
    expect(parseVisualizationUri(uri)).toBeNull()
  })

  it('非法会话 ID 不能构造地址', () => {
    expect(() => buildVisualizationUri({ sessionId: '../x', sha256: SHA })).toThrow()
  })
})

describe('工具结果', () => {
  it('结果正文往返并解析出快照地址', () => {
    const uri = buildVisualizationUri({ sessionId: 's1', sha256: SHA })
    expect(parseVisualizationResult(formatVisualizationResult({ title: '架构图', uri, bytes: 10 }))).toEqual({
      title: '架构图',
      uri,
      bytes: 10,
      address: { sessionId: 's1', sha256: SHA }
    })
  })

  it.each([
    ['缺失', undefined],
    ['非 JSON', '可视化未展示'],
    ['未展示', JSON.stringify({ presented: false })],
    ['地址不是快照', JSON.stringify({ presented: true, title: 't', uri: 'https://example.com', bytes: 1 })],
    ['字段类型错误', JSON.stringify({ presented: true, title: 1, uri: 'x', bytes: '1' })]
  ])('%s的结果无法解析', (_label, result) => {
    expect(parseVisualizationResult(result)).toBeNull()
  })
})

describe('主题投影', () => {
  it('接受颜色函数、字体栈与长度字面值', () => {
    const value = theme({
      fg: 'rgba(0, 0, 0, 0.12)',
      accent: 'oklch(0.7 0.1 250 / 50%)',
      'font-sans': '-apple-system, "Segoe UI", "微软雅黑", sans-serif',
      radius: '8px'
    })
    expect(parseVisualizationTheme(value)).toEqual(value)
  })

  it.each([
    ['闭合声明', 'red; } body { display: none'],
    ['闭合标签', '</style><script>alert(1)</script>'],
    ['远程地址', 'url(https://example.com/x.png)'],
    ['CSS 转义', '\\3c script'],
    ['空值', '']
  ])('拒绝含%s的 token', (_label, token) => {
    expect(parseVisualizationTheme(theme({ bg: token }))).toBeNull()
  })

  it('缺少 token 或配色方案非法时整份拒绝', () => {
    const { bg: _bg, ...partial } = theme().tokens
    expect(parseVisualizationTheme({ scheme: 'dark', tokens: partial })).toBeNull()
    expect(parseVisualizationTheme({ ...theme(), scheme: 'sepia' })).toBeNull()
  })
})

describe('帧初始化参数', () => {
  const uri = buildVisualizationUri({ sessionId: 's1', sha256: SHA })

  it('随帧地址往返', () => {
    const init = { theme: theme(), motionScale: 4, maxHeight: 720 }
    expect(parseVisualizationFrameInit(buildVisualizationFrameSrc(uri, init))).toEqual(init)
  })

  it('缺失或越界时拒绝', () => {
    expect(parseVisualizationFrameInit(uri)).toBeNull()
    expect(parseVisualizationFrameInit(buildVisualizationFrameSrc(uri, { theme: theme(), motionScale: 0.5, maxHeight: 720 }))).toBeNull()
    expect(parseVisualizationFrameInit(buildVisualizationFrameSrc(uri, { theme: theme(), motionScale: 1, maxHeight: 1e9 }))).toBeNull()
  })
})
