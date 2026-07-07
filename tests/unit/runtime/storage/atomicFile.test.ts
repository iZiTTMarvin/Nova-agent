import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { atomicWriteFileSync } from '../../../../src/runtime/storage/atomicFile'

describe('atomicWriteFileSync', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-atomic-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('写入后目标文件内容正确', () => {
    const target = path.join(tmpDir, 'data.json')
    atomicWriteFileSync(target, '{"ok":true}', 'utf8')
    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}')
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)
  })

  it('空内容原子写入可被读取为空', () => {
    const target = path.join(tmpDir, 'empty.jsonl')
    atomicWriteFileSync(target, '', 'utf8')
    expect(fs.readFileSync(target, 'utf8')).toBe('')
  })

  it('写入过程中留下 .tmp 且 rename 失败时不覆盖原文件', () => {
    const target = path.join(tmpDir, 'keep.jsonl')
    fs.writeFileSync(target, 'original\n', 'utf8')

    const tmpPath = `${target}.tmp`
    fs.writeFileSync(tmpPath, 'partial', 'utf8')
    // 模拟崩溃：仅有 .tmp、未完成 rename
    expect(fs.readFileSync(target, 'utf8')).toBe('original\n')
    expect(fs.existsSync(tmpPath)).toBe(true)
  })
})
