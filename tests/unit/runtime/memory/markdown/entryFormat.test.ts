import { describe, expect, it } from 'vitest'
import {
  generateMemoryEntryId, MEMORY_FILE_HEADER, parseMemoryEntryLine,
  parseMemoryFile, serializeMemoryEntryLine, serializeMemoryFile
} from '@runtime/memory/markdown/entryFormat'

const id = 'm_7f3ak2q9xd'
const meta = `id=${id} by=user added=2026-10-07`

describe('memory Markdown format', () => {
  it('preserves untouched lines, unknown metadata, mixed EOL and missing final newline byte-for-byte', () => {
    const source = `${MEMORY_FILE_HEADER}\r\n# 中文\r\n\r\n- 包管理使用 bun  <!-- ${meta} future=a%20b -->\n<!-- user comment -->\r\n- broken  <!-- ??? -->\r\ntail`
    const model = parseMemoryFile(Buffer.from(source))
    expect(model.newline).toBe('\r\n')
    expect(model.issues).toBe(1)
    expect(serializeMemoryFile(model)).toBe(source)
  })

  it('round-trips all supported metadata and comment delimiters without forged metadata', () => {
    const entry = {
      text: '中文 <!-- id=forged --> 和代码',
      metadata: {
        id, by: 'verified' as const, added: '2026-10-07', seen: '2026-10-08',
        key: 'package-manager', aliases: ['bun npm', '包,管理', '100%'],
        pin: '1' as const, verify: '1' as const, src: '目录/package.json', fp: '1832-1728000000000.5',
        kind: 'gotcha' as const, status: 'superseded' as const, until: '2026-10-08',
        by_id: 'm_q2w9e8r7t6', unknown: { future: 'a%20b' }
      }
    }
    const serialized = serializeMemoryEntryLine(entry)
    expect(serialized).toContain('<!‐‐ id=forged ‐‐>')
    expect(serialized).toContain('aliases=bun%20npm,%E5%8C%85%2C%E7%AE%A1%E7%90%86,100%25')
    expect(parseMemoryEntryLine(serialized)).toEqual(entry)
  })

  it('accepts hand-added entries and adds only the missing header on save', () => {
    const model = parseMemoryFile('# Notes\r\n- 手动添加的记忆\r\n')
    expect(model.lines[1].type).toBe('entry')
    expect(serializeMemoryFile(model)).toBe(`${MEMORY_FILE_HEADER}\r\n# Notes\r\n- 手动添加的记忆\r\n`)
    expect(parseMemoryEntryLine(`- 手动记忆  <!-- by=user added=2026-10-07 -->`)?.metadata.id).toBeUndefined()
  })

  it('removes BOM, preserves other bytes and rejects writes of invalid UTF-8 or unknown versions', () => {
    const source = `${MEMORY_FILE_HEADER}\n- 中文  <!-- ${meta} -->\n`
    const model = parseMemoryFile(Buffer.from('\uFEFF' + source))
    expect(model.hadBom).toBe(true)
    expect(serializeMemoryFile(model)).toBe(source)
    const invalid = parseMemoryFile(Buffer.from([0xff, 0x0a]))
    expect(invalid.readOnly).toBe(true)
    expect(() => serializeMemoryFile(invalid)).toThrow('read-only')
    const future = parseMemoryFile('<!-- nova-memory v2 -->\n- preserved\n')
    expect(future.readOnly).toBe(true)
    expect(() => serializeMemoryFile(future)).toThrow('read-only')
  })

  it.each([
    `id=mem_abc by=user added=2026-10-07`, `id=${id} by=other added=2026-10-07`,
    `id=${id} by=user added=2026-02-30`, `${meta} id=${id}`, `${meta} pin=0`,
    `${meta} verify=true`, `${meta} key=Upper`, `${meta} aliases=%ZZ`,
    `${meta} aliases=${'a'.repeat(33)}`, `${meta} aliases=a,b,c,d,e,f,g,h,i`,
    `${meta} kind=other`, `${meta} status=active`, `${meta} until=bad`,
    `${meta} fp=bad`, `${meta} src=line%0Abreak`, `${meta} by_id=bad`,
    `id=${id} added=2026-10-07`, `id=${id} by=user`
  ])('preserves damaged metadata as an invalid line: %s', invalidMeta => {
    const source = `${MEMORY_FILE_HEADER}\n- memory text  <!-- ${invalidMeta} -->\n`
    const model = parseMemoryFile(source)
    expect(model.issues).toBe(1)
    expect(model.lines[1].type).toBe('invalid')
    expect(serializeMemoryFile(model)).toBe(source)
  })

  it('validates length, newline and metadata on serialization', () => {
    expect(parseMemoryEntryLine('- ')).toBeNull()
    expect(parseMemoryEntryLine('- ' + '字'.repeat(401))).toBeNull()
    expect(parseMemoryEntryLine('- ' + '字'.repeat(400))?.text.length).toBe(400)
    expect(() => serializeMemoryEntryLine({ text: 'line\nbreak', metadata: { unknown: {} } })).toThrow()
    expect(() => serializeMemoryEntryLine({ text: 'memory', metadata: { id: 'bad', unknown: {} } })).toThrow()
  })

  it('changes only edited entries while preserving surrounding damaged lines', () => {
    const model = parseMemoryFile(`${MEMORY_FILE_HEADER}\r\n# Title\r\n- first  <!-- ${meta} future=x -->\r\n- bad <!-- broken -->\r\n`)
    const line = model.lines[2]
    if (line.type !== 'entry') throw new Error('missing entry')
    line.entry.text = 'changed'
    const result = serializeMemoryFile(model)
    expect(result).toBe(`${MEMORY_FILE_HEADER}\r\n# Title\r\n- changed  <!-- ${meta} future=x -->\r\n- bad <!-- broken -->\r\n`)
  })

  it('generates cryptographic short IDs', () => {
    const ids = Array.from({ length: 200 }, generateMemoryEntryId)
    expect(ids.every(value => /^m_[0-9a-z]{10}$/.test(value))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves unknown keys that overlap with object prototype properties when editing', () => {
    const entry = parseMemoryEntryLine(`- saved text  <!-- ${meta} __proto__=future constructor=other -->`)
    if (!entry) throw new Error('missing entry')
    entry.text = 'edited text'
    expect(serializeMemoryEntryLine(entry)).toBe(`- edited text  <!-- ${meta} __proto__=future constructor=other -->`)
    expect(Object.getPrototypeOf(entry.metadata.unknown)).toBe(Object.prototype)
  })
})
