import { describe, it, expect } from 'vitest'
import {
  resolveToolArg,
  unwrapDegenerateAutolink
} from '../../../../src/runtime/tools/toolArgResolver'

describe('unwrapDegenerateAutolink', () => {
  it('展开链接文本等于无协议 URL 的退化自动链接', () => {
    expect(unwrapDegenerateAutolink('[notes.md](http://notes.md)')).toBe('notes.md')
    expect(unwrapDegenerateAutolink('[src/index.ts](https://src/index.ts)')).toBe('src/index.ts')
  })

  it('真 Markdown 链接（文本与目标不同）原样保留', () => {
    const value = '[click](https://example.com)'
    expect(unwrapDegenerateAutolink(value)).toBe(value)
  })

  it('普通路径与含方括号的目录不受影响', () => {
    expect(unwrapDegenerateAutolink('a.ts')).toBe('a.ts')
    expect(unwrapDegenerateAutolink('src/[wip]/notes.md')).toBe('src/[wip]/notes.md')
  })
})

describe('resolveToolArg', () => {
  it('正式名优先，别名按清单顺序兜底', () => {
    expect(resolveToolArg({ path: 'a.ts' }, 'path')).toBe('a.ts')
    expect(resolveToolArg({ filePath: 'a.ts' }, 'path')).toBe('a.ts')
    expect(resolveToolArg({ file_path: 'b.ts', filename: 'a.ts' }, 'path')).toBe('b.ts')
  })

  it('非字符串值 String 兜底', () => {
    expect(resolveToolArg({ path: 123 }, 'path')).toBe('123')
  })

  it('全部缺失返回 undefined', () => {
    expect(resolveToolArg({}, 'path')).toBeUndefined()
  })

  it('路径参数中的退化自动链接被展开', () => {
    expect(resolveToolArg({ path: '[notes.md](http://notes.md)' }, 'path')).toBe('notes.md')
  })

  it('命令与模式类别同样生效', () => {
    expect(resolveToolArg({ cmd: '[run.sh](http://run.sh)' }, 'command')).toBe('run.sh')
    expect(resolveToolArg({ search: 'TODO' }, 'pattern')).toBe('TODO')
  })
})
