/**
 * OutputSink — 统一大输出截断 + artifact 指针生成
 *
 * 小输出原样返回；超限则写入 ArtifactStore，上下文只保留 head + 截断提示。
 * bash 流式路径由 OutputAccumulator 落盘，此处提供 formatNotice 复用截断模板。
 */
import type { ArtifactStore } from '../artifacts/ArtifactStore'
import { countTextLines } from '../artifacts/ArtifactStore'
import { truncateHead } from './bash/truncate'

export interface OutputSinkOptions {
  /** 进入模型上下文的最大字节数，默认 50KB */
  maxContextBytes?: number
  /** 进入模型上下文的最大行数，默认 3000 */
  maxContextLines?: number
  artifactStore: ArtifactStore
  sessionId: string
  toolName: string
}

export interface SinkResult {
  /** 实际进入 tool result / 模型上下文的文本 */
  contextText: string
  artifactId?: string
  truncationNotice: string
  truncationMeta?: {
    totalBytes: number
    totalLines: number
    shownLines: number
    truncated: boolean
  }
}

const DEFAULT_MAX_CONTEXT_BYTES = 50_000
const DEFAULT_MAX_CONTEXT_LINES = 3000

export class OutputSink {
  private readonly maxContextBytes: number
  private readonly maxContextLines: number
  private readonly artifactStore: ArtifactStore
  private readonly sessionId: string
  private readonly toolName: string

  constructor(options: OutputSinkOptions) {
    this.maxContextBytes = options.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES
    this.maxContextLines = options.maxContextLines ?? DEFAULT_MAX_CONTEXT_LINES
    this.artifactStore = options.artifactStore
    this.sessionId = options.sessionId
    this.toolName = options.toolName
  }

  /**
   * 对大段文本做二次控量：未超限原样返回；超限写 artifact 并保留 head + 指针。
   */
  async finalize(text: string): Promise<SinkResult> {
    const totalBytes = Buffer.byteLength(text, 'utf8')
    const totalLines = countTextLines(text)

    if (totalBytes <= this.maxContextBytes) {
      return {
        contextText: text,
        truncationNotice: '',
        truncationMeta: {
          totalBytes,
          totalLines,
          shownLines: totalLines,
          truncated: false
        }
      }
    }

    const artifact = await this.artifactStore.write(this.sessionId, text, {
      toolName: this.toolName,
      truncated: true
    })

    const head = truncateHead(text, {
      maxBytes: this.maxContextBytes,
      maxLines: this.maxContextLines
    })
    const shownLines = head.outputLines
    const nextOffset = shownLines + 1
    const notice = OutputSink.formatNotice({
      totalLines,
      totalBytes,
      shownLines,
      artifactId: artifact.id,
      nextOffset
    })

    const contextText = head.content.length > 0 ? `${head.content}\n${notice}` : notice
    return {
      contextText,
      artifactId: artifact.id,
      truncationNotice: notice,
      truncationMeta: {
        totalBytes,
        totalLines,
        shownLines,
        truncated: true
      }
    }
  }

  /** 生成统一的 artifact 截断提示（bash / grep 等复用） */
  static formatNotice(params: {
    totalLines: number
    totalBytes: number
    shownLines: number
    artifactId: string
    nextOffset: number
  }): string {
    return [
      `[输出已截断: 共 ${params.totalLines} 行 / ${params.totalBytes} 字节。上下文保留 ${params.shownLines} 行。`,
      `完整输出: artifact://${params.artifactId}`,
      `续读: read path="artifact://${params.artifactId}" offset=${params.nextOffset} limit=500]`
    ].join('\n')
  }
}
