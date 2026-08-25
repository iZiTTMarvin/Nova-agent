/**
 * 会话输出日志：游标推进式读取 + 滚动尾窗保留 + 超阈值溢出落盘 + 数据到达信号。
 * 只存调用方已净化（ANSI 剥离、回车折叠）的文本，不负责进程生命周期。
 * 溢出文件名前缀 nova-bash- 被 storageService.runStartupGc 按前缀清扫跨启动残留，不可改名。
 */
import { createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadPage } from './types'

/** 滚动尾窗保留的完整行数上限 */
export const RETENTION_MAX_LINES = 2000
/** 滚动尾窗保留的字节上限 */
export const RETENTION_MAX_BYTES = 50 * 1024
/** 累计产量超过该值后开始溢出落盘 */
export const SPILL_THRESHOLD_BYTES = 50 * 1024
/** 单页读取的完整行数上限 */
export const READ_PAGE_MAX_LINES = 400
/** 单页读取的字节上限 */
export const READ_PAGE_MAX_BYTES = 16 * 1024

/**
 * 游标与尾窗偏移按字符计数（多字节安全），字节只用于上限统计；
 * totalChars 始终等于尾窗末端在总输出流中的偏移，因此 hasMore/unread 不会
 * 因窗口丢弃而出现“永远读不到的空页”。
 */
export class SessionOutputJournal {
  private windowText = ''
  private windowStartChars = 0
  private windowLineCount = 0
  private windowBytes = 0
  private totalChars = 0
  private totalBytes = 0
  private totalLines = 0
  private deliveredChars = 0
  private settled = false
  private disposed = false
  private droppedEarly = false
  private spillPath: string | null = null
  private spillStream: ReturnType<typeof createWriteStream> | null = null
  private readonly spillDir: string | undefined
  private readonly outputListeners = new Set<() => void>()
  private readonly settledListeners = new Set<() => void>()

  constructor(opts: { seed?: string; spillDir?: string } = {}) {
    this.spillDir = opts.spillDir
    if (opts.seed) this.append(opts.seed)
  }

  append(text: string): void {
    if (this.settled || this.disposed || text === '') return
    const newlines = countNewlines(text)
    this.totalChars += text.length
    this.totalBytes += Buffer.byteLength(text)
    this.totalLines += newlines
    this.windowText += text
    this.windowLineCount += newlines
    this.windowBytes += Buffer.byteLength(text)
    if (!this.spillStream && this.totalBytes > SPILL_THRESHOLD_BYTES) {
      // 开启时先回填当前尾窗（含本次 append），溢出文件因此覆盖开启前的全部产量
      this.openSpill()
    } else if (this.spillStream) {
      this.spillStream.write(text)
    }
    this.trimWindow()
    this.emit(this.outputListeners)
  }

  /** 进程已退出：不再有新数据，关闭溢出写流（文件留在磁盘等 artifact 认领）；幂等 */
  settle(): void {
    if (this.settled) return
    this.settled = true
    this.closeSpill()
    this.emit(this.settledListeners)
  }

  /** 读取一页未读内容并推进游标（游标只推进已返回的内容；被窗口丢弃的区间直接跳过） */
  readUnread(): ReadPage {
    // 窗口已丢弃的未读区间不可交付，游标越过它，否则每页都会从窗口头重复切片
    if (this.deliveredChars < this.windowStartChars) this.deliveredChars = this.windowStartChars
    const start = this.deliveredChars
    if (this.totalChars - start <= 0) {
      return { text: '', hasMore: false, droppedEarly: this.droppedEarly, spill: this.spillInfo() }
    }
    const available = this.windowText.slice(start - this.windowStartChars)
    const text = takePage(available)
    this.deliveredChars += text.length
    const hasMore = this.totalChars - Math.max(this.deliveredChars, this.windowStartChars) > 0
    if (this.settled && !hasMore) {
      // 已读尽且不会再有数据：释放尾窗内存，只留终态计数
      this.releaseWindow()
    }
    return { text, hasMore, droppedEarly: this.droppedEarly, spill: this.spillInfo() }
  }

  hasUnread(): boolean {
    return this.totalChars - Math.max(this.deliveredChars, this.windowStartChars) > 0
  }

  /** 未读且仍留在尾窗中的字节数（用于容量上限统计） */
  unreadBytes(): number {
    const start = Math.max(this.deliveredChars, this.windowStartChars)
    return Buffer.byteLength(this.windowText.slice(start - this.windowStartChars))
  }

  onOutput(listener: () => void): () => void {
    this.outputListeners.add(listener)
    return () => {
      this.outputListeners.delete(listener)
    }
  }

  onSettled(listener: () => void): () => void {
    if (this.settled) {
      // 已终态后订阅也要立即唤醒，否则有界等待方会悬挂
      listener()
      return () => {}
    }
    this.settledListeners.add(listener)
    return () => {
      this.settledListeners.delete(listener)
    }
  }

  /** 释放内存与溢出流（范围终态清理时调用）；幂等 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeSpill()
    this.releaseWindow()
    if (!this.settled) {
      this.settled = true
      this.emit(this.settledListeners)
    }
  }

  private openSpill(): void {
    const dir = this.spillDir ?? tmpdir()
    const path = join(dir, `nova-bash-${randomBytes(8).toString('hex')}.log`)
    const stream = createWriteStream(path, { mode: 0o600 })
    stream.on('error', (err) => {
      // 落盘失败不中断会话输出；spill 信息作废，读取方退回滚动窗口
      console.error(`[process-journal] 溢出日志写入失败: ${path}`, err)
      if (this.spillStream === stream) this.spillStream = null
      this.spillPath = null
    })
    this.spillPath = path
    this.spillStream = stream
    stream.write(this.windowText)
  }

  private closeSpill(): void {
    const stream = this.spillStream
    if (!stream) return
    this.spillStream = null
    stream.end()
  }

  private releaseWindow(): void {
    this.windowText = ''
    this.windowStartChars = this.totalChars
    this.windowLineCount = 0
    this.windowBytes = 0
  }

  private trimWindow(): void {
    if (this.windowLineCount <= RETENTION_MAX_LINES && this.windowBytes <= RETENTION_MAX_BYTES) return
    const lines = this.windowText.split('\n')
    // 末段可能是未终结的部分行，不占完整行名额
    let bytes = Buffer.byteLength(lines[lines.length - 1] ?? '')
    let keptLines = 0
    let start = lines.length - 1
    while (start > 0) {
      const prevBytes = Buffer.byteLength(lines[start - 1] ?? '') + 1
      if (keptLines + 1 > RETENTION_MAX_LINES || bytes + prevBytes > RETENTION_MAX_BYTES) break
      keptLines += 1
      bytes += prevBytes
      start -= 1
    }
    const kept = lines.slice(start).join('\n')
    const droppedChars = this.windowText.length - kept.length
    if (droppedChars > 0) {
      this.droppedEarly = true
      this.windowStartChars += droppedChars
    }
    this.windowText = kept
    this.windowLineCount = keptLines
    this.windowBytes = bytes
    if (this.windowBytes > RETENTION_MAX_BYTES && this.windowText.indexOf('\n') === -1) {
      // 无换行的超长单行：只能保尾部，否则内存无界（防御路径，正常输出不会出现）
      this.windowText = tailByBytes(this.windowText, RETENTION_MAX_BYTES)
      this.windowStartChars = this.totalChars - this.windowText.length
      this.windowLineCount = 0
      this.windowBytes = Buffer.byteLength(this.windowText)
      this.droppedEarly = true
    }
  }

  private spillInfo(): ReadPage['spill'] {
    return this.spillPath
      ? { path: this.spillPath, totalBytes: this.totalBytes, totalLines: this.totalLines }
      : null
  }

  private emit(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) listener()
  }
}

/** 按行数与字节双上限截取一页；首行超字节上限时按字符边界截断，保证游标总能推进 */
function takePage(text: string): string {
  const lines = text.split('\n')
  let taken = ''
  let takenBytes = 0
  let completeLines = 0
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    const piece = isLast ? (lines[i] ?? '') : `${lines[i] ?? ''}\n`
    const pieceBytes = Buffer.byteLength(piece)
    if (i > 0 && (completeLines >= READ_PAGE_MAX_LINES || takenBytes + pieceBytes > READ_PAGE_MAX_BYTES)) {
      break
    }
    if (takenBytes + pieceBytes > READ_PAGE_MAX_BYTES) {
      let budget = READ_PAGE_MAX_BYTES - takenBytes
      let cut = 0
      for (const ch of piece) {
        const b = Buffer.byteLength(ch)
        if (b > budget) break
        budget -= b
        cut += ch.length
      }
      taken += piece.slice(0, cut)
      break
    }
    taken += piece
    takenBytes += pieceBytes
    if (!isLast) completeLines += 1
  }
  return taken
}

function countNewlines(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1
  return n
}

/** 保留末尾不超过 maxBytes 的内容（字符边界，不撕裂代理对） */
function tailByBytes(text: string, maxBytes: number): string {
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const b = Buffer.byteLength(chars[start - 1] ?? '')
    if (bytes + b > maxBytes) break
    bytes += b
    start -= 1
  }
  return chars.slice(start).join('')
}
