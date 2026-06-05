/**
 * output-accumulator.ts — 流式输出收集器
 *
 * 设计目标：
 * 1. 接收子进程 stdout/stderr 的二进制 chunks（流式），不卡在内存里。
 * 2. 内存中只保留"尾部预览"——最近约 2*maxBytes 的可解码文本（用于错误信息展示）。
 * 3. 累计总字节数 / 总行数 / 是否被截断的元信息，供上层 ToolResult 决策。
 * 4. 当总输出超过 maxBytes 时，把已收集的内容落到临时文件
 *    （路径 `os.tmpdir()/nova-bash-{random}.log`），后续 chunk 直接 append。
 * 5. UTF-8 跨 chunk 安全：用 `TextDecoder({ stream: true })`，未完成的
 *    多字节序列会自动保留在 decoder 内部，下一个 chunk 到来时拼接。
 * 6. 行边界安全：尾部预览的起点必须落在行边界，避免出现"半行"乱码。
 *
 * 为什么不直接用字符串拼接？
 * - 长输出（10MB+）会让 V8 字符串拼接 / 截断变成 O(n²)，整页卡死。
 * - 子进程 chunk 经常在多字节字符中间切断（中文 / emoji 常见），拼接
 *   出来的字符串本身就是损坏的，后续再解码会出错。
 */
import { createWriteStream, type WriteStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from './truncate'
import type { OutputSnapshot, TruncationResult } from './types'

export interface OutputAccumulatorOptions {
  maxBytes?: number
  maxLines?: number
  /** 临时文件名前缀，便于调试 */
  tempFilePrefix?: string
}

const DEFAULT_TEMP_PREFIX = 'nova-bash-'

/**
 * OutputAccumulator — 流式收集 + 滚动尾窗口 + 临时文件溢出
 *
 * 用法：
 * ```
 * const acc = new OutputAccumulator()
 * child.stdout.on('data', chunk => acc.append(chunk))
 * child.stderr.on('data', chunk => acc.append(chunk))
 * await waitForChildProcess(child)
 * acc.finish()
 * const snap = acc.snapshot()
 * await acc.closeTempFile()
 * ```
 */
export class OutputAccumulator {
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly tailWindowBytes: number
  private readonly tempFilePrefix: string

  /** 已 flush 的解码文本片段（首段，丢到 head 时被替换为 tailText 的旧部分）。 */
  private headText = ''

  /** 滚动尾窗口：保存最近 ~2*maxBytes 的解码文本。 */
  private tailText = ''

  /** 尾部窗口起点是否恰好在行边界上（行边界安全标记）。 */
  private tailStartsAtLineBoundary = true

  /** 累计已写出的字节数（按 UTF-8 字节）。 */
  private totalBytes = 0

  /** 累计 '\n' 数量 + 1（最后一行没有 '\n' 也算一行）。 */
  private totalLines = 0

  /** 跨 chunk 流式 UTF-8 解码器。 */
  private readonly decoder: TextDecoder

  /** 是否已经触发临时文件溢出。 */
  private useTempFile = false
  private tempFilePath: string | null = null
  private tempStream: WriteStream | null = null

  /** 标记是否已 finish。 */
  private finished = false

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    this.tailWindowBytes = this.maxBytes * 2
    this.tempFilePrefix = options.tempFilePrefix ?? DEFAULT_TEMP_PREFIX
    this.decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  }

  /**
   * 流式追加一个 chunk。
   *
   * - 解码（流式）后喂入 tailText
   * - tailText 超出 tailWindowBytes 时，把前面部分搬到 headText
   * - 累计 totalBytes / totalLines
   * - 当 totalBytes > maxBytes 时，触发临时文件溢出
   */
  append(chunk: Buffer | string): void {
    if (this.finished) return
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.totalBytes += buf.byteLength

    if (this.useTempFile) {
      // 已经溢出：tail 窗口不再追加完整文本，避免 O(n²)
      // 但仍要更新 totalLines / 触发行数截断判断
      this.tempStream?.write(buf)
      this.updateLineCount(buf)
      return
    }

    const text = this.decoder.decode(buf, { stream: true })
    if (text.length === 0) return

    this.tailText += text
    this.updateLineCount(buf)

    if (this.tailText.length > this.tailWindowBytes) {
      this.rotateTail()
    }

    // 触发溢出阈值
    if (this.totalBytes > this.maxBytes) {
      this.spillToTempFile()
    }
  }

  /**
   * 标记输出结束。
   *
   * flush decoder 内部残留的未完成多字节序列（如果整个输出在多字节字符中间
   * 结束，TextDecoder 会以 U+FFFD 替代，但 `stream:true` 不会丢字符——这就是
   * 我们想要的）。
   */
  finish(): void {
    if (this.finished) return
    this.finished = true
    const tail = this.decoder.decode()
    if (tail.length > 0) {
      this.tailText += tail
      if (this.tailText.length > this.tailWindowBytes) {
        this.rotateTail()
      }
    }
  }

  /**
   * 获取当前输出快照。
   *
   * - 完整文本：headText + tailText（最多 ~3*maxBytes 的内存占用）
   * - 截断后的内容：经过 truncateTail 裁到 maxBytes / maxLines
   * - 临时文件路径：仅在已溢出时设置
   */
  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const fullText = this.headText + this.tailText
    const fullBytes = Buffer.byteLength(fullText, 'utf8')
    // 这里 totalLines 是已经包含 '\n' 计数的；为了 truncateTail 处理方便，
    // 临时组装 lines 数组（只在已截断时才有性能开销）
    const truncation: TruncationResult = truncateTail(fullText, {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes
    })

    const out: OutputSnapshot = {
      content: truncation.content,
      fullText,
      truncated: truncation.truncated,
      truncatedBy: truncation.truncatedBy,
      totalLines: this.totalLines,
      totalBytes: fullBytes,
      outputLines: truncation.outputLines,
      outputBytes: truncation.outputBytes,
      lastLinePartial: truncation.lastLinePartial
    }

    if (truncation.truncated && this.useTempFile && this.tempFilePath) {
      out.fullOutputPath = this.tempFilePath
    } else if (truncation.truncated && options.persistIfTruncated) {
      // 即便未溢出（只是行数截断），调用方显式要求持久化时也落盘
      const path = this.persistFullText(fullText)
      out.fullOutputPath = path
    }

    return out
  }

  /** 关闭临时文件写入流。必须在 finish 之后、snapshot 之后调用。 */
  async closeTempFile(): Promise<void> {
    if (this.tempStream) {
      await new Promise<void>((resolve) => {
        this.tempStream!.end(() => resolve())
      })
      this.tempStream = null
    }
  }

  /**
   * 取最后一行的字节数。
   *
   * 配合 snapshot 使用：让上层知道"最后一行是否完整"以决定是否需要
   * 提示模型去查看完整文件。
   */
  getLastLineBytes(): number {
    const text = this.tailText
    const lastNl = text.lastIndexOf('\n')
    const lastLine = lastNl === -1 ? text : text.slice(lastNl + 1)
    return Buffer.byteLength(lastLine, 'utf8')
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 累计行数。
   *
   * 直接扫描 chunk 中的 '\n' 字节数（不需要先解码），
   * 性能比 split('\n').length 高得多。
   */
  private updateLineCount(buf: Buffer): void {
    if (this.totalLines === 0) {
      // 第一行：只要有任何字节就至少 1 行
      this.totalLines = 1
    }
    for (let i = 0; i < buf.byteLength; i++) {
      if (buf[i] === 0x0a) this.totalLines += 1
    }
  }

  /**
   * 滚动尾窗口：把超长 tailText 的前段搬到 headText。
   *
   * 关键约束：搬走的边界必须在 '\n' 上，保证 tailText 起点是行边界。
   */
  private rotateTail(): void {
    const overflow = this.tailText.length - this.tailWindowBytes
    // 找一个 '\n'，把前面的整段扔到 headText
    const candidate = this.tailText.indexOf('\n', overflow)
    if (candidate === -1) {
      // tailText 里找不到行边界：保守地保留全部 tailText（避免半行）
      return
    }
    const splitAt = candidate + 1 // 包含换行符
    this.headText += this.tailText.slice(0, splitAt)
    this.tailText = this.tailText.slice(splitAt)
    this.tailStartsAtLineBoundary = true
  }

  /** 把已收集内容落盘到临时文件，后续 chunk 直接追加。 */
  private spillToTempFile(): void {
    if (this.useTempFile) return
    this.useTempFile = true

    const fileName = `${this.tempFilePrefix}${randomBytes(8).toString('hex')}.log`
    this.tempFilePath = join(tmpdir(), fileName)
    this.tempStream = createWriteStream(this.tempFilePath, { flags: 'w' })

    // head + tail 当前的内容写到文件开头
    const fullText = this.headText + this.tailText
    this.tempStream.write(fullText)

    // 内存只保留 tail 窗口的"最近一段"，避免继续 O(n²)
    // 注意：headText 清空、tailText 仍保留——这样 snapshot() 还能给出
    // 尾部预览。
    this.headText = ''
  }

  /**
   * 把当前 fullText 落盘（用于"显式要求持久化"的场景）。
   * 返回落盘的文件路径。
   */
  private persistFullText(text: string): string {
    const fileName = `${this.tempFilePrefix}${randomBytes(8).toString('hex')}.log`
    const path = join(tmpdir(), fileName)
    this.tempStream = createWriteStream(path, { flags: 'w' })
    this.tempStream.write(text)
    this.tempFilePath = path
    this.useTempFile = true
    return path
  }
}
