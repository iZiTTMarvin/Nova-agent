import { describe, expect, it } from 'vitest'
import {
  normalizeFallbackToolName,
  parseTextToolCall,
  parseTextToolCalls,
  stripTextToolCall,
  stripTextToolCalls,
  stripLeakedToolMarkup
} from '../../../src/shared/tool-call-text-fallback'

describe('tool-call-text-fallback', () => {
  it('将 fenced JSON 里的 list_directory 归一化为 ls', () => {
    const parsed = parseTextToolCalls([
      '我来看看当前目录。',
      '',
      '```json',
      '{',
      '  "name": "list_directory",',
      '  "arguments": {',
      '    "path": "."',
      '  }',
      '}',
      '```'
    ].join('\n'))

    expect(parsed).toEqual({
      toolCalls: [{
        rawToolName: 'list_directory',
        toolName: 'ls',
        arguments: { path: '.' }
      }],
      visibleText: '我来看看当前目录。'
    })
  })

  it('支持 OpenAI 风格 function 包装', () => {
    const parsed = parseTextToolCalls([
      '```json',
      JSON.stringify({
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/main.ts' })
        }
      }),
      '```'
    ].join('\n'))

    expect(parsed).toEqual({
      toolCalls: [{
        rawToolName: 'read_file',
        toolName: 'read',
        arguments: { path: 'src/main.ts' }
      }],
      visibleText: ''
    })
  })

  it('解析行内多个 JSON 伪调用（MiniMax-M3 典型输出）', () => {
    const text = '我先看目录结构。{ "name": "directory_tree", "arguments": { "path": ".", "max_depth": 3 } } 然后读 README：{ "name": "read_file", "arguments": { "path": "README.md" } }'
    const parsed = parseTextToolCalls(text)

    expect(parsed?.toolCalls).toHaveLength(2)
    expect(parsed?.toolCalls[0]).toEqual({
      rawToolName: 'directory_tree',
      toolName: 'ls',
      arguments: { path: '.', max_depth: 3 }
    })
    expect(parsed?.toolCalls[1]).toEqual({
      rawToolName: 'read_file',
      toolName: 'read',
      arguments: { path: 'README.md' }
    })
    expect(parsed?.visibleText).toBe('我先看目录结构。 然后读 README：')
  })

  it('解析 MiniMax XML 风格 invoke 调用', () => {
    const text = '让我执行命令。\u003cinvoke name="bash"\u003e\u003ccommand\u003edir\u003c/command\u003e\u003cdescription\u003eList files\u003c/description\u003e\u003c/invoke\u003e'
    const parsed = parseTextToolCalls(text)

    expect(parsed?.toolCalls).toHaveLength(1)
    expect(parsed?.toolCalls[0]).toEqual({
      rawToolName: 'bash',
      toolName: 'bash',
      arguments: { command: 'dir', description: 'List files' }
    })
    expect(parsed?.visibleText).toBe('让我执行命令。')
  })

  it('未知工具名不误判', () => {
    expect(parseTextToolCalls('```json\n{"name":"weather","arguments":{"city":"beijing"}}\n```')).toBeNull()
    expect(stripTextToolCalls('普通文本')).toBe('普通文本')
    expect(normalizeFallbackToolName('weather')).toBeNull()
  })

  it('parseTextToolCall 兼容旧 API 只返回第一条', () => {
    const text = '调用 ls 和 read。{ "name": "ls", "arguments": { "path": "." } } { "name": "read", "arguments": { "path": "a.md" } }'
    const single = parseTextToolCall(text)
    expect(single?.toolName).toBe('ls')
  })

  it('stripTextToolCalls 移除所有行内伪调用', () => {
    const raw = '我先看看。{ "name": "ls", "arguments": { "path": "." } } 然后读文件。{ "name": "read_file", "arguments": { "path": "README.md" } }'
    expect(stripTextToolCalls(raw)).toBe('我先看看。 然后读文件。')
  })

  it('stripTextToolCall 兼容旧 API 移除所有行内伪调用', () => {
    const raw = '先查看一下。{ "name": "ls", "arguments": { "path": "." } }'
    expect(stripTextToolCall(raw)).toBe('先查看一下。')
  })

  it('stripLeakedToolMarkup 剥离 DeepSeek DSML 标记', () => {
    const FULLWIDTH_PIPE = '\uFF5C'
    const raw =
      `说明文字` +
      `<${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}invoke name="grep">` +
      `<${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}parameter name="pattern">x` +
      `</${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}parameter>` +
      `</${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}invoke>`
    expect(stripLeakedToolMarkup(raw)).toBe('说明文字')
  })

  it('stripLeakedToolMarkup 不破坏普通比较表达式', () => {
    const code = 'while (a < b && c > d) {}'
    expect(stripLeakedToolMarkup(code)).toBe(code)
  })
})
