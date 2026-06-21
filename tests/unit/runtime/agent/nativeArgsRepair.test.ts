import { describe, expect, it } from 'vitest'
import { needsRepair, repairNativeArguments, repairEmptyArgsFromContent } from '../../../../src/runtime/agent/stream/nativeArgsRepair'

/**
 * Native 工具调用参数修复层测试。
 *
 * 覆盖真实日志中观察到的坏数据形态（来自 .cursor/debug-bb9d42.log），
 * 以及正常调用不被误伤的回归守护。
 */

function tryParse(raw: string): Record<string, unknown> {
  try {
    const o = JSON.parse(raw)
    return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

describe('needsRepair —— 坏数据识别', () => {
  it('整段 XML 被塞进 arguments：命中', () => {
    const raw = '{"invoke name=\\"edit\\"": "\\n<parameter name=\\"filePath\\">index.html"}'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(true)
  })

  it('arguments 本身就是完整 XML：命中', () => {
    const raw = '<invoke name="read"><parameter name="path">foo.ts</parameter></invoke>'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(true)
  })

  it('闭合标签残片作为 key（/path）：命中', () => {
    const raw = '{"/path":"</invoke>\\n<invoke name=\\"read\\">"}'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(true)
  })

  it('参数名带尖括号：命中', () => {
    const raw = '{"<parameter name=\\"path\\">":"foo.ts"}'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(true)
  })

  it('正常 native JSON 调用：不命中', () => {
    const raw = '{"filePath":"index.html","edits":[{"oldText":"a","newText":"b"}]}'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(false)
  })

  it('正常只读工具调用：不命中', () => {
    const raw = '{"path":"src/foo.ts","offset":10,"limit":50}'
    const parsed = tryParse(raw)
    expect(needsRepair(raw, parsed)).toBe(false)
  })

  it('空对象 + arguments 无 XML：不命中', () => {
    expect(needsRepair('{}', {})).toBe(false)
  })

  it('空对象 + arguments 含裸标签前缀：命中', () => {
    expect(needsRepair('<invoke', {})).toBe(true)
  })
})

describe('repairNativeArguments —— 真实坏样本修复', () => {
  it('edit 被塞成 {invoke name="edit": XML 片段}', () => {
    // 直接复刻 .cursor/debug-bb9d42.log 中的坏样本：
    // 模型把 XML 塞进 native arguments，key 变成 'invoke name="edit"'，
    // value 是未闭合的 XML 片段。
    const raw = JSON.stringify({
      'invoke name="edit"': '\n<parameter name="filePath">index.html'
    })
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('edit', raw, parsed)

    expect(repaired.filePath).toBe('index.html')
  })

  it('read 被塞成 {/path: 残片}', () => {
    // 用户报告的第二个失败样本：key 是闭合标签残片 '/path'，
    // value 含完整 <invoke>...</parameter>（未闭合）。
    const raw = JSON.stringify({
      '/path': '</invoke>\n<invoke name="read">\n<parameter name="path">compus_mange.iml'
    })
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired.path).toBe('compus_mange.iml')
  })
  it('arguments 本身是完整 XML invoke', () => {
    const raw = '<invoke name="read"><parameter name="path">src/foo.ts</parameter></invoke>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired.path).toBe('src/foo.ts')
  })

  it('arguments 是裸 parameter 片段（无外层 invoke）', () => {
    const raw = '<parameter name="path">src/bar.ts</parameter>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired.path).toBe('src/bar.ts')
  })

  it('多参数 XML 片段修复', () => {
    const raw = '<parameter name="path">a.ts</parameter><parameter name="offset">10</parameter>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired.path).toBe('a.ts')
    // offset 经 tryJsonParseIfLooksLikeJson 转成 number
    expect(repaired.offset).toBe(10)
  })

  it('JSON value 里嵌着 XML 片段也能拼回', () => {
    // 形如 { "someKey": "<parameter name=\"path\">x.ts</parameter>" }
    const raw = '{"someKey":"<parameter name=\\"path\\">x.ts</parameter>"}'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired.path).toBe('x.ts')
  })

  it('bash command 修复', () => {
    const raw = '<invoke name="bash"><parameter name="command">ls -la</parameter></invoke>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('bash', raw, parsed)

    expect(repaired.command).toBe('ls -la')
  })

  it('write content 修复（含特殊字符）', () => {
    const raw = '<invoke name="write"><parameter name="path">out.txt</parameter><parameter name="content">hello &amp; world</parameter></invoke>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('write', raw, parsed)

    expect(repaired.path).toBe('out.txt')
    // entity 解码
    expect(repaired.content).toBe('hello & world')
  })
})

describe('repairNativeArguments —— 回归守护', () => {
  it('正常 native args 原样返回（同一对象引用）', () => {
    const raw = '{"filePath":"index.html","edits":[{"oldText":"a","newText":"b"}]}'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('edit', raw, parsed)

    expect(repaired).toBe(parsed)
    expect(repaired.filePath).toBe('index.html')
  })

  it('空 arguments 无法修复时返回原 parsed', () => {
    const repaired = repairNativeArguments('read', '', {})
    expect(repaired).toEqual({})
  })

  it('无 XML 特征的垃圾 JSON 不被误修复', () => {
    const raw = '{"random":"stuff"}'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('read', raw, parsed)

    expect(repaired).toBe(parsed)
  })

  it('toolName 与 XML 中 name 不一致时，仍取同名调用', () => {
    // 极端情况：服务端 toolName 与 arguments 里嵌的 invoke name 不一致
    const raw = '<invoke name="read"><parameter name="path">x.ts</parameter></invoke>'
    const parsed = tryParse(raw)
    const repaired = repairNativeArguments('edit', raw, parsed)

    // 优先取 toolName="edit"，但 XML 里是 read；fallback 取第一个有内容的
    expect(repaired.path).toBe('x.ts')
  })
})

describe('repairEmptyArgsFromContent —— 正文兜底补全', () => {
  it('空 arguments 的 toolCall 从正文 XML 补全', () => {
    const toolCalls = [
      { id: 'tc1', name: 'read', arguments: '' },
      { id: 'tc2', name: 'grep', arguments: '{}' }
    ]
    const content = '我来读取文件\n<invoke name="read"><parameter name="path">src/foo.ts</parameter></invoke>'

    const repaired = repairEmptyArgsFromContent(toolCalls, content)

    expect(repaired).toEqual(['tc1'])
    expect(JSON.parse(toolCalls[0].arguments).path).toBe('src/foo.ts')
    // tc2 正文里没有同名调用，保持空
    expect(toolCalls[1].arguments).toBe('{}')
  })

  it('多个空 toolCall 对应正文多个 XML 调用，按名匹配补全', () => {
    const toolCalls = [
      { id: 'tc_read', name: 'read', arguments: '' },
      { id: 'tc_bash', name: 'bash', arguments: '' }
    ]
    const content = '<invoke name="read"><parameter name="path">a.ts</parameter></invoke>\n<invoke name="bash"><parameter name="command">ls</parameter></invoke>'

    const repaired = repairEmptyArgsFromContent(toolCalls, content)

    expect(repaired).toEqual(['tc_read', 'tc_bash'])
    expect(JSON.parse(toolCalls[0].arguments).path).toBe('a.ts')
    expect(JSON.parse(toolCalls[1].arguments).command).toBe('ls')
  })

  it('正文无 XML 特征时不扫描，原样返回空', () => {
    const toolCalls = [{ id: 'tc1', name: 'read', arguments: '' }]
    const repaired = repairEmptyArgsFromContent(toolCalls, '这是普通正文，没有工具调用')
    expect(repaired).toEqual([])
    expect(toolCalls[0].arguments).toBe('')
  })

  it('已有参数的 toolCall 不被覆盖', () => {
    const toolCalls = [
      { id: 'tc1', name: 'read', arguments: '{"path":"existing.ts"}' }
    ]
    const content = '<invoke name="read"><parameter name="path">other.ts</parameter></invoke>'

    const repaired = repairEmptyArgsFromContent(toolCalls, content)

    expect(repaired).toEqual([])
    expect(JSON.parse(toolCalls[0].arguments).path).toBe('existing.ts')
  })

  it('正文有 XML 但无同名调用时不补全（避免把 A 工具参数塞给 B 工具）', () => {
    const toolCalls = [{ id: 'tc1', name: 'edit', arguments: '' }]
    const content = '<invoke name="read"><parameter name="path">x.ts</parameter></invoke>'

    const repaired = repairEmptyArgsFromContent(toolCalls, content)

    // 严格同名匹配：edit 在正文里没对应调用，保持空，不 fallback 取 read
    expect(repaired).toEqual([])
    expect(toolCalls[0].arguments).toBe('')
  })

  it('非法 JSON 的 arguments 也被视为空', () => {
    const toolCalls = [{ id: 'tc1', name: 'read', arguments: '{broken' }]
    const content = '<invoke name="read"><parameter name="path">y.ts</parameter></invoke>'

    const repaired = repairEmptyArgsFromContent(toolCalls, content)

    expect(repaired).toEqual(['tc1'])
    expect(JSON.parse(toolCalls[0].arguments).path).toBe('y.ts')
  })

  it('空 toolCalls 或空正文直接返回空', () => {
    expect(repairEmptyArgsFromContent([], '<invoke/>')).toEqual([])
    expect(repairEmptyArgsFromContent([{ id: 'x', name: 'read', arguments: '' }], '')).toEqual([])
  })
})
