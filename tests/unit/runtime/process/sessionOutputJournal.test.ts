/**
 * 会话输出日志单测：游标分页、溢出落盘、滚动窗口丢弃、通知与幂等。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { finished } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READ_PAGE_MAX_BYTES,
  READ_PAGE_MAX_LINES,
  RETENTION_MAX_LINES,
  SessionOutputJournal,
  SPILL_THRESHOLD_BYTES
} from '../../../../src/runtime/process/journal'

const spillDirs: string[] = []
const spillStreams: fs.WriteStream[] = []
const createWriteStream = fs.createWriteStream

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>()
}))

beforeEach(() => {
  vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
    const stream = createWriteStream(...args)
    spillStreams.push(stream)
    return stream
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const stream of spillStreams.splice(0)) {
    if (!stream.writableEnded) stream.end()
    await finished(stream, { cleanup: true })
  }
  for (const dir of spillDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionOutputJournal', () => {
  it('游标按页推进：全部页拼接等于全部输出，页受行数/字节上限约束', () => {
    const journal = new SessionOutputJournal({ seed: 'seed-header\n' })
    const parts: string[] = ['seed-header\n']
    for (let i = 0; i < 900; i++) {
      const l = `line-${String(i).padStart(5, '0')}\n`
      parts.push(l)
      journal.append(l)
    }
    // 总量 9010 字节远低于字节上限，分页由 400 行上限驱动
    const first = journal.readUnread()
    expect(first.text).toBe(parts.slice(0, READ_PAGE_MAX_LINES).join(''))
    expect(first.hasMore).toBe(true)
    expect(first.droppedEarly).toBe(false)
    expect(first.spill).toBeNull()

    const pages = [first.text]
    for (;;) {
      const page = journal.readUnread()
      pages.push(page.text)
      if (!page.hasMore) break
    }
    expect(pages.join('')).toBe(parts.join(''))
    expect(journal.hasUnread()).toBe(false)
    expect(journal.readUnread().text).toBe('')
  })

  it('单块无换行大输出按字节上限分页，拼接无损（防止游标停滞）', () => {
    const journal = new SessionOutputJournal()
    const chunk = 'x'.repeat(40_000)
    journal.append(chunk)
    expect(journal.unreadBytes()).toBe(40_000)
    const pages: string[] = []
    for (;;) {
      const page = journal.readUnread()
      pages.push(page.text)
      if (!page.hasMore) break
    }
    expect(pages.length).toBeGreaterThanOrEqual(3)
    for (const p of pages.slice(0, -1)) {
      expect(Buffer.byteLength(p)).toBe(READ_PAGE_MAX_BYTES)
    }
    expect(pages.join('')).toBe(chunk)
  })

  it('总量超阈值触发溢出落盘：文件内容完整、settle 后可读、spill 信息随页带出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-journal-spill-'))
    spillDirs.push(dir)
    const journal = new SessionOutputJournal({ spillDir: dir })
    const parts: string[] = []
    for (let i = 0; i < 1200; i++) {
      const l = `${String(i).padStart(6, '0')} ${'d'.repeat(54)}\n`
      parts.push(l)
      journal.append(l)
    }
    const total = parts.join('')
    expect(Buffer.byteLength(total)).toBeGreaterThan(SPILL_THRESHOLD_BYTES)
    journal.settle()
    expect(spillStreams).toHaveLength(1)
    await Promise.all(spillStreams.map(stream => finished(stream, { cleanup: true })))
    expect(spillStreams[0].closed).toBe(true)

    const before = journal.unreadBytes()
    const first = journal.readUnread()
    const spill = first.spill
    expect(spill).not.toBeNull()
    if (spill) {
      expect(spill.path).toMatch(/nova-bash-[0-9a-f]{16}\.log$/)
      expect(spill.totalBytes).toBe(Buffer.byteLength(total))
      expect(spill.totalLines).toBe(1200)
      expect(readFileSync(spill.path, 'utf8')).toBe(total)
    }
    // settle 后未读内容仍可继续分页读取；交付量与读前 unreadBytes 对账且为总输出的后缀
    const pages: string[] = [first.text]
    for (;;) {
      const page = journal.readUnread()
      pages.push(page.text)
      if (!page.hasMore) break
    }
    const delivered = pages.join('')
    expect(Buffer.byteLength(delivered)).toBe(before)
    expect(total.endsWith(delivered)).toBe(true)
    expect(journal.hasUnread()).toBe(false)
  })

  it('滚动窗口按行数上限丢弃最早内容并置位 droppedEarly，交付量与 unreadBytes 对账', () => {
    const journal = new SessionOutputJournal()
    const parts: string[] = []
    for (let i = 0; i < RETENTION_MAX_LINES + 600; i++) {
      const l = `row-${String(i).padStart(5, '0')}\n`
      parts.push(l)
      journal.append(l)
    }
    // 2600 行 × 10B = 26KB，未触字节上限，仅触发行数上限
    const before = journal.unreadBytes()
    const first = journal.readUnread()
    expect(first.droppedEarly).toBe(true)
    expect(first.text.startsWith('row-00000')).toBe(false)
    let delivered = Buffer.byteLength(first.text)
    for (;;) {
      const page = journal.readUnread()
      delivered += Buffer.byteLength(page.text)
      if (!page.hasMore) break
    }
    expect(delivered).toBe(before)
    expect(journal.hasUnread()).toBe(false)
  })

  it('onOutput 每次数据到达触发，取消订阅后不再触发', () => {
    const journal = new SessionOutputJournal()
    const calls: string[] = []
    const off = journal.onOutput(() => calls.push('a'))
    journal.onOutput(() => calls.push('b'))
    journal.append('x')
    off()
    journal.append('y')
    expect(calls).toEqual(['a', 'b', 'b'])
  })

  it('onSettled 在 settle 时触发一次且幂等；settle 之后订阅立即唤醒', () => {
    const journal = new SessionOutputJournal()
    let n = 0
    const off = journal.onSettled(() => {
      n += 1
    })
    journal.settle()
    journal.settle()
    off()
    expect(n).toBe(1)

    let late = 0
    journal.onSettled(() => {
      late += 1
    })
    expect(late).toBe(1)
  })

  it('settle 后 append 不再生效；dispose 幂等并清空未读', () => {
    const journal = new SessionOutputJournal()
    journal.append('before\n')
    journal.settle()
    journal.append('after\n')
    const page = journal.readUnread()
    expect(page.text).toBe('before\n')
    expect(page.hasMore).toBe(false)
    journal.dispose()
    journal.dispose()
    expect(journal.hasUnread()).toBe(false)
    expect(journal.readUnread().text).toBe('')

    const j2 = new SessionOutputJournal()
    j2.append('pending')
    j2.dispose()
    expect(j2.hasUnread()).toBe(false)
  })
})
