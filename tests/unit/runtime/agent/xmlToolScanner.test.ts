import { describe, expect, it } from 'vitest'
import {
  parseXmlToolCalls,
  stripMinimaxArtifacts,
  XmlToolScanner
} from '../../../../src/runtime/agent/xmlToolScanner'

describe('xmlToolScanner', () => {
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

  it('流式 scanner 不会重复返回同一个调用', () => {
    const scanner = new XmlToolScanner()
    const calls1 = scanner.feed('<invoke name="ls"><parameter name="path">.</parameter></invoke>')
    expect(calls1).toHaveLength(1)
    const calls2 = scanner.feed('')
    expect(calls2).toHaveLength(0)
  })

  it('scanner 增量返回新出现的调用', () => {
    const scanner = new XmlToolScanner()
    const calls1 = scanner.feed('先看目录：<invoke name="ls"><parameter name="path">.')
    expect(calls1).toHaveLength(0)

    const calls2 = scanner.feed('.</parameter></invoke> 再读文件：<invoke name="read"><parameter name="path">README.md')
    expect(calls2).toHaveLength(1)
    expect(calls2[0].name).toBe('ls')

    const calls3 = scanner.feed('</parameter></invoke>')
    expect(calls3).toHaveLength(1)
    expect(calls3[0].name).toBe('read')

    expect(scanner.flushText()).toBe('先看目录： 再读文件：')
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
