import { describe, expect, it } from 'vitest'
import {
  parseXmlToolCalls,
  stripMinimaxArtifacts,
  XmlToolScanner,
  type XmlScanEvent
} from '../../../../src/runtime/agent/xmlToolScanner'

/**
 * XML 增量扫描器测试
 *
 * 覆盖：
 * - 完整单次 feed
 * - 逐字符 feed（最细粒度）
 * - 标签跨 chunk 切断
 * - 参数值跨 chunk 切断
 * - 多工具调用、多参数
 * - XML entity 转义
 * - MiniMax 占位符
 * - 正文与工具调用混合
 * - 代码尖括号（非标签）不被误判
 * - 与 parseXmlToolCalls 全量解析等价
 * - flush / reset 行为
 */

// 辅助：收集 feed 序列的所有事件
function collectEvents(scanner: XmlToolScanner, chunks: string[]): XmlScanEvent[] {
  const events: XmlScanEvent[] = []
  for (const chunk of chunks) {
    for (const ev of scanner.feed(chunk)) {
      events.push(ev)
    }
  }
  return events
}

// 辅助：逐字符 feed 并收集事件
function feedCharByChar(scanner: XmlToolScanner, text: string): XmlScanEvent[] {
  const events: XmlScanEvent[] = []
  for (let i = 0; i < text.length; i++) {
    for (const ev of scanner.feed(text[i])) {
      events.push(ev)
    }
  }
  return events
}

describe('XmlToolScanner — 增量流式扫描', () => {
  // ==================== 基础：完整单次 feed ====================

  it('完整单次 feed：正文 + 单个工具调用', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '我先看看目录。\n<invoke name="ls"><parameter name="path">.</parameter></invoke>'
    )

    expect(events).toHaveLength(4) // text, toolStart, toolArgDelta, toolEnd

    expect(events[0]).toEqual({ type: 'text', text: '我先看看目录。\n' })
    expect(events[1]).toMatchObject({ type: 'toolStart', name: 'ls' })
    expect(events[2]).toMatchObject({ type: 'toolArgDelta', key: 'path', delta: '.' })
    expect(events[3]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })

    // toolStart 和 toolEnd 的 id 应一致
    const id = (events[1] as Extract<XmlScanEvent, { type: 'toolStart' }>).id
    expect((events[2] as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).id).toBe(id)
    expect((events[3] as Extract<XmlScanEvent, { type: 'toolEnd' }>).id).toBe(id)
  })

  it('完整单次 feed：纯正文无工具调用', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed('你好，我来帮你分析这个问题。')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', text: '你好，我来帮你分析这个问题。' })
  })

  it('完整单次 feed：仅工具调用无正文', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="bash"><parameter name="command">dir</parameter></invoke>'
    )

    expect(events).toHaveLength(3) // toolStart, toolArgDelta, toolEnd
    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'bash' })
    expect(events[1]).toMatchObject({ type: 'toolArgDelta', key: 'command', delta: 'dir' })
    expect(events[2]).toMatchObject({
      type: 'toolEnd',
      name: 'bash',
      arguments: { command: 'dir' }
    })
  })

  // ==================== 逐字符 feed（最细粒度） ====================

  it('逐字符 feed：正文 + 工具调用', () => {
    const scanner = new XmlToolScanner()
    const text = 'Hi\n<invoke name="ls"><parameter name="path">.</parameter></invoke>'
    const events = feedCharByChar(scanner, text)

    const textEvents = events.filter(e => e.type === 'text')
    const toolStarts = events.filter(e => e.type === 'toolStart')
    const argDeltas = events.filter(e => e.type === 'toolArgDelta')
    const toolEnds = events.filter(e => e.type === 'toolEnd')

    expect(toolStarts).toHaveLength(1)
    expect(toolStarts[0]).toMatchObject({ type: 'toolStart', name: 'ls' })
    expect(argDeltas).toHaveLength(1)
    expect(argDeltas[0]).toMatchObject({ type: 'toolArgDelta', key: 'path', delta: '.' })
    expect(toolEnds).toHaveLength(1)
    expect(toolEnds[0]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })

    // 正文应完整保留
    const fullText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text).join('')
    expect(fullText).toBe('Hi\n')
  })

  it('逐字符 feed：参数值逐字到达', () => {
    const scanner = new XmlToolScanner()
    const text = '<invoke name="write"><parameter name="content">hello world</parameter></invoke>'
    const events = feedCharByChar(scanner, text)

    // content 参数值应被逐字吐出
    const contentDeltas = events.filter(
      e => e.type === 'toolArgDelta' && (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).key === 'content'
    )
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1)

    // 拼接所有 content delta 应得到完整值
    const fullContent = contentDeltas
      .map(e => (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).delta)
      .join('')
    expect(fullContent).toBe('hello world')

    // 最终 toolEnd 应有完整 arguments
    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { content: 'hello world' }
    })
  })

  // ==================== 标签跨 chunk 切断 ====================

  it('invoke 开始标签被切断', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '前面文字<invoke name="ls"',
      '><parameter name="path">.</parameter></invoke>'
    ])

    expect(events[0]).toEqual({ type: 'text', text: '前面文字' })
    expect(events[1]).toMatchObject({ type: 'toolStart', name: 'ls' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })
  })

  it('invoke 开始标签在 name 属性中间被切断', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '<invoke name="l',
      's"><parameter name="path">.</parameter></invoke>'
    ])

    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'ls' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })
  })

  it('parameter 开始标签被切断', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '<invoke name="read"><param',
      'eter name="path">README.md</parameter></invoke>'
    ])

    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'read' })
    expect(events[1]).toMatchObject({ type: 'toolArgDelta', key: 'path', delta: 'README.md' })
    expect(events[2]).toMatchObject({
      type: 'toolEnd',
      name: 'read',
      arguments: { path: 'README.md' }
    })
  })

  it('parameter 结束标签被切断', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '<invoke name="ls"><parameter name="path">/some/long/path</par',
      'ameter></invoke>'
    ])

    const argDeltas = events.filter(e => e.type === 'toolArgDelta')
    const fullPath = argDeltas.map(e => (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).delta).join('')
    expect(fullPath).toBe('/some/long/path')

    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '/some/long/path' }
    })
  })

  it('invoke 结束标签被切断', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '<invoke name="ls"><parameter name="path">.</parameter></inv',
      'oke>后面文字'
    ])

    expect(events[events.length - 2]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })
    expect(events[events.length - 1]).toEqual({ type: 'text', text: '后面文字' })
  })

  // ==================== 参数值跨 chunk 切断 ====================

  it('参数值跨多个 chunk 逐步到达', () => {
    const scanner = new XmlToolScanner()
    const events = collectEvents(scanner, [
      '<invoke name="write"><parameter name="content">第一行\n',
      '第二行\n',
      '第三行</parameter></invoke>'
    ])

    const contentDeltas = events.filter(
      e => e.type === 'toolArgDelta' && (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).key === 'content'
    )
    expect(contentDeltas.length).toBeGreaterThanOrEqual(2)

    const fullContent = contentDeltas
      .map(e => (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).delta)
      .join('')
    expect(fullContent).toBe('第一行\n第二行\n第三行')
  })

  it('参数值在 chunk 边界恰好是 < 字符', () => {
    const scanner = new XmlToolScanner()
    // 参数值包含 < 符号（如代码片段），不应被误判为标签
    const events = collectEvents(scanner, [
      '<invoke name="write"><parameter name="content">const x = a < b && c > d</parameter></invoke>'
    ])

    const contentDeltas = events.filter(
      e => e.type === 'toolArgDelta' && (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).key === 'content'
    )
    const fullContent = contentDeltas
      .map(e => (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).delta)
      .join('')
    expect(fullContent).toBe('const x = a < b && c > d')
  })

  // ==================== 多工具调用 ====================

  it('多个工具调用顺序识别', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '先看结构再读文件。\n' +
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>\n' +
      '<invoke name="read"><parameter name="path">README.md</parameter></invoke>'
    )

    const toolStarts = events.filter(e => e.type === 'toolStart')
    const toolEnds = events.filter(e => e.type === 'toolEnd')

    expect(toolStarts).toHaveLength(2)
    expect(toolStarts[0]).toMatchObject({ name: 'ls' })
    expect(toolStarts[1]).toMatchObject({ name: 'read' })

    // 两个调用的 id 应不同
    const id0 = (toolStarts[0] as Extract<XmlScanEvent, { type: 'toolStart' }>).id
    const id1 = (toolStarts[1] as Extract<XmlScanEvent, { type: 'toolStart' }>).id
    expect(id0).not.toBe(id1)

    expect(toolEnds).toHaveLength(2)
    expect(toolEnds[0]).toMatchObject({ name: 'ls', arguments: { path: '.' } })
    expect(toolEnds[1]).toMatchObject({ name: 'read', arguments: { path: 'README.md' } })
  })

  it('多个工具调用逐字符 feed', () => {
    const scanner = new XmlToolScanner()
    const text =
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>' +
      '<invoke name="read"><parameter name="path">a.md</parameter></invoke>'
    const events = feedCharByChar(scanner, text)

    const toolEnds = events.filter(e => e.type === 'toolEnd')
    expect(toolEnds).toHaveLength(2)
    expect(toolEnds[0]).toMatchObject({ name: 'ls' })
    expect(toolEnds[1]).toMatchObject({ name: 'read' })
  })

  // ==================== 多参数 ====================

  it('多参数工具调用（path + content）', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="write">' +
      '<parameter name="path">src/a.ts</parameter>' +
      '<parameter name="content">const x = 1;</parameter>' +
      '</invoke>'
    )

    const argDeltas = events.filter(e => e.type === 'toolArgDelta')
    expect(argDeltas).toHaveLength(2)
    expect(argDeltas[0]).toMatchObject({ key: 'path', delta: 'src/a.ts' })
    expect(argDeltas[1]).toMatchObject({ key: 'content', delta: 'const x = 1;' })

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { path: 'src/a.ts', content: 'const x = 1;' }
    })
  })

  it('多参数逐字符 feed', () => {
    const scanner = new XmlToolScanner()
    const text =
      '<invoke name="write">' +
      '<parameter name="path">src/a.ts</parameter>' +
      '<parameter name="content">hello</parameter>' +
      '</invoke>'
    const events = feedCharByChar(scanner, text)

    const pathDeltas = events.filter(
      e => e.type === 'toolArgDelta' && (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).key === 'path'
    )
    const contentDeltas = events.filter(
      e => e.type === 'toolArgDelta' && (e as Extract<XmlScanEvent, { type: 'toolArgDelta' }>).key === 'content'
    )

    expect(pathDeltas.length).toBeGreaterThanOrEqual(1)
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1)

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { path: 'src/a.ts', content: 'hello' }
    })
  })

  // ==================== XML entity 转义 ====================

  it('还原 XML entity：&lt; &amp; &quot;', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="write">' +
      '<parameter name="content">if (a &lt; b &amp;&amp; c &gt; d) { return &quot;ok&quot;; }</parameter>' +
      '</invoke>'
    )

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { content: 'if (a < b && c > d) { return "ok"; }' }
    })
  })

  it('entity 在逐字符 feed 中正确还原', () => {
    const scanner = new XmlToolScanner()
    const text =
      '<invoke name="write"><parameter name="content">a &lt; b</parameter></invoke>'
    const events = feedCharByChar(scanner, text)

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { content: 'a < b' }
    })
  })

  // ==================== MiniMax 占位符 ====================

  it('MiniMax 占位符在流式扫描中被清理', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '让我执行。]<minimax>[<invoke name="bash"><parameter name="command">dir</parameter></invoke>]</minimax>['
    )

    // 正文不应包含 minimax 占位符
    const textEvents = events.filter(e => e.type === 'text')
    const fullText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).delta ?? '').join('')
    // Actually text events have 'text' field, not 'delta'
    const joinedText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text).join('')
    expect(joinedText).not.toContain('minimax')
    expect(joinedText).toContain('让我执行。')

    // 工具调用应被正确识别
    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'bash',
      arguments: { command: 'dir' }
    })
  })

  // ==================== 正文与工具调用混合 ====================

  it('正文-工具-正文 交替', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '我先看看。\n' +
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>\n' +
      '看到文件了，再读一下。\n' +
      '<invoke name="read"><parameter name="path">a.ts</parameter></invoke>\n' +
      '读完了。'
    )

    const textEvents = events.filter(e => e.type === 'text')
    const fullText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text).join('')
    expect(fullText).toBe('我先看看。\n\n看到文件了，再读一下。\n\n读完了。')

    const toolEnds = events.filter(e => e.type === 'toolEnd')
    expect(toolEnds).toHaveLength(2)
  })

  it('正文中包含 invoke 标签的原始 XML 不应出现在 text 事件中', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '执行命令：<invoke name="bash"><parameter name="command">npm test</parameter></invoke>'
    )

    const textEvents = events.filter(e => e.type === 'text')
    const fullText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text).join('')
    expect(fullText).not.toContain('<invoke')
    expect(fullText).not.toContain('<parameter')
    expect(fullText).not.toContain('</invoke>')
    expect(fullText).toBe('执行命令：')
  })

  // ==================== 代码尖括号不被误判 ====================

  it('正文中的 <div> 等 HTML 标签不被误判为工具调用', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed('代码是 <div class="container"> 这样的。')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'text',
      text: '代码是 <div class="container"> 这样的。'
    })
  })

  it('正文中的 <T> 泛型尖括号不被误判', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed('类型是 Array<T> 和 List<string>。')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'text',
      text: '类型是 Array<T> 和 List<string>。'
    })
  })

  it('正文中的 </div> 闭合标签不被误判', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed('前面</div>后面')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', text: '前面</div>后面' })
  })

  it('参数值中的尖括号不被误判（代码片段场景）', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="write">' +
      '<parameter name="content">function foo<T>(x: T): T { return x; }</parameter>' +
      '</invoke>'
    )

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { content: 'function foo<T>(x: T): T { return x; }' }
    })
  })

  // ==================== 与 parseXmlToolCalls 等价 ====================

  it('逐字符 feed 的最终结果与全量 parseXmlToolCalls 一致', () => {
    const text =
      '先看目录。\n' +
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>\n' +
      '再读文件。\n' +
      '<invoke name="read"><parameter name="path">src/main.ts</parameter></invoke>'

    // 全量解析
    const parsed = parseXmlToolCalls(text)

    // 逐字符 feed
    const scanner = new XmlToolScanner()
    const events = feedCharByChar(scanner, text)

    const toolEnds = events.filter(e => e.type === 'toolEnd')
    expect(toolEnds).toHaveLength(parsed.toolCalls.length)

    for (let i = 0; i < parsed.toolCalls.length; i++) {
      const endEvent = toolEnds[i] as Extract<XmlScanEvent, { type: 'toolEnd' }>
      expect(endEvent.name).toBe(parsed.toolCalls[i].name)
      expect(endEvent.arguments).toEqual(parsed.toolCalls[i].arguments)
    }

    // 正文也应一致
    const textEvents = events.filter(e => e.type === 'text')
    const fullText = textEvents.map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text).join('')
    expect(fullText.trim()).toBe(parsed.visibleText.trim())
  })

  it('多参数场景与全量解析一致', () => {
    const text =
      '<invoke name="write">' +
      '<parameter name="path">src/utils.ts</parameter>' +
      '<parameter name="content">export const x = 1;\nexport const y = 2;</parameter>' +
      '</invoke>'

    const parsed = parseXmlToolCalls(text)
    const scanner = new XmlToolScanner()
    const events = feedCharByChar(scanner, text)

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: parsed.toolCalls[0].arguments
    })
  })

  // ==================== flush 行为 ====================

  it('flush 返回流结束后残留的纯文本', () => {
    const scanner = new XmlToolScanner()
    scanner.feed('前面文字<invoke name="ls"><parameter name="path">.</parameter></invoke>')
    const flushEvents = scanner.flush()

    // 完整调用后 flush 应无残留事件（或仅剩余空白）
    const textFromFlush = flushEvents
      .filter(e => e.type === 'text')
      .map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text)
      .join('')
    expect(textFromFlush).toBe('')
  })

  it('flush 处理已识别的未闭合调用（尝试 finalize）', () => {
    const scanner = new XmlToolScanner()
    // 喂入已识别出 invoke + parameter 但未闭合的内容
    scanner.feed('<invoke name="ls"><parameter name="path">.')
    const flushEvents = scanner.flush()

    // 已识别的调用应被 finalize（产出 toolEnd）
    const toolEnd = flushEvents.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })
  })

  it('flush 处理完全无法识别的残留（IDLE 中半截标签当正文）', () => {
    const scanner = new XmlToolScanner()
    // 只喂了半个 invoke 开始标签，scanner 还在 IDLE 中
    // 注意："一些文字" 在 feed 阶段已作为 text emit，flush 只处理残留
    const feedEvents = scanner.feed('一些文字<invoke name="ls"')
    // feed 阶段应已吐出前半部分正文
    const feedText = feedEvents
      .filter(e => e.type === 'text')
      .map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text)
      .join('')
    expect(feedText).toBe('一些文字')

    // flush 吐出无法识别的残留（半截标签）
    const flushEvents = scanner.flush()
    const flushText = flushEvents
      .filter(e => e.type === 'text')
      .map(e => (e as Extract<XmlScanEvent, { type: 'text' }>).text)
      .join('')
    expect(flushText.length).toBeGreaterThan(0)
    expect(flushText).toContain('<invoke')
  })

  it('flush 后 scanner 回到干净状态', () => {
    const scanner = new XmlToolScanner()
    scanner.feed('<invoke name="ls"><parameter name="path">.</parameter></invoke>')
    scanner.flush()

    // 再 feed 新内容应正常工作
    const events = scanner.feed('新文字')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text', text: '新文字' })
  })

  // ==================== reset 行为 ====================

  it('reset 清空所有内部状态', () => {
    const scanner = new XmlToolScanner()
    scanner.feed('<invoke name="ls"><parameter name="path">.</parameter>')

    scanner.reset()

    // 重置后应像新 scanner 一样
    const events = scanner.feed(
      '<invoke name="read"><parameter name="path">a.md</parameter></invoke>'
    )
    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'read' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'read',
      arguments: { path: 'a.md' }
    })
  })

  // ==================== 边界情况 ====================

  it('空字符串 feed 不产生事件', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed('')
    expect(events).toHaveLength(0)
  })

  it('连续空 feed 后正常 feed', () => {
    const scanner = new XmlToolScanner()
    scanner.feed('')
    scanner.feed('')
    const events = scanner.feed(
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>'
    )
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'ls' })
  })

  it('invoke 标签属性有额外空白', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke  name = "ls" ><parameter name="path">.</parameter></invoke>'
    )

    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'ls' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '.' }
    })
  })

  it('parameter 标签属性有额外空白', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="ls"><parameter  name = "path" >.</parameter></invoke>'
    )

    expect(events[1]).toMatchObject({ type: 'toolArgDelta', key: 'path', delta: '.' })
  })

  it('工具名包含连字符（如 agent-skills:build）', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="agent-skills:build"><parameter name="prompt">任务描述</parameter></invoke>'
    )

    expect(events[0]).toMatchObject({ type: 'toolStart', name: 'agent-skills:build' })
    expect(events[events.length - 1]).toMatchObject({
      type: 'toolEnd',
      name: 'agent-skills:build',
      arguments: { prompt: '任务描述' }
    })
  })

  it('参数值为空字符串', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="ls"><parameter name="path"></parameter></invoke>'
    )

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'ls',
      arguments: { path: '' }
    })
  })

  it('参数值包含换行符', () => {
    const scanner = new XmlToolScanner()
    const events = scanner.feed(
      '<invoke name="write"><parameter name="content">line1\nline2\nline3</parameter></invoke>'
    )

    const toolEnd = events.find(e => e.type === 'toolEnd')
    expect(toolEnd).toMatchObject({
      type: 'toolEnd',
      name: 'write',
      arguments: { content: 'line1\nline2\nline3' }
    })
  })
})

// ==================== 保留旧测试：parseXmlToolCalls 全量解析 ====================

describe('parseXmlToolCalls — 全量解析（兜底，行为不变）', () => {
  it('解析单个 XML invoke 调用', () => {
    const text = '我先看看目录。\n<invoke name="ls"><parameter name="path">.</parameter></invoke>'
    const parsed = parseXmlToolCalls(text)
    expect(parsed.toolCalls).toEqual([{ name: 'ls', arguments: { path: '.' } }])
    expect(parsed.visibleText).toBe('我先看看目录。')
  })

  it('解析多个 XML invoke 调用', () => {
    const text = [
      '我先看结构再读文件。',
      '<invoke name="ls"><parameter name="path">.</parameter></invoke>',
      '<invoke name="read"><parameter name="path">README.md</parameter></invoke>'
    ].join('\n')
    const parsed = parseXmlToolCalls(text)
    expect(parsed.toolCalls).toEqual([
      { name: 'ls', arguments: { path: '.' } },
      { name: 'read', arguments: { path: 'README.md' } }
    ])
    expect(parsed.visibleText).toBe('我先看结构再读文件。')
  })

  it('自动把 JSON 字面量参数解析成对应类型', () => {
    const text = '<invoke name="bash"><parameter name="command">dir</parameter><parameter name="timeout">30</parameter><parameter name="interactive">false</parameter></invoke>'
    const parsed = parseXmlToolCalls(text)
    expect(parsed.toolCalls[0].arguments).toEqual({
      command: 'dir',
      timeout: 30,
      interactive: false
    })
  })

  it('清理 MiniMax 占位符后解析', () => {
    const text = '让我执行。]<minimax>[<invoke name="bash"><parameter name="command">dir</parameter></invoke>]</minimax>['
    const cleaned = stripMinimaxArtifacts(text)
    expect(cleaned).toBe('让我执行。<invoke name="bash"><parameter name="command">dir</parameter></invoke>')
    const parsed = parseXmlToolCalls(cleaned)
    expect(parsed.toolCalls).toEqual([{ name: 'bash', arguments: { command: 'dir' } }])
  })

  it('兼容 edit 使用子标签而非 parameter 包裹', () => {
    const text = [
      '<invoke name="edit">',
      '<filePath>index.html</filePath>',
      '<old>const x = 1</old>',
      '<new>const x = 2</new>',
      '</invoke>'
    ].join('')
    const parsed = parseXmlToolCalls(text)
    expect(parsed.toolCalls[0]).toEqual({
      name: 'edit',
      arguments: {
        filePath: 'index.html',
        old: 'const x = 1',
        new: 'const x = 2'
      }
    })
  })

  it('parameter 标签优先于同名子标签', () => {
    const text = '<invoke name="read"><parameter name="path">from-param</parameter><path>from-child</path></invoke>'
    const parsed = parseXmlToolCalls(text)
    expect(parsed.toolCalls[0].arguments.path).toBe('from-param')
  })
})
