/**
 * 流式 think 标签解析状态机
 *
 * 处理模型在 content 字段中返回的 <think'>'...</think'>' 标签，
 * 将思考内容与正文正确分离。
 *
 * 四态: normal → checking_open → thinking → checking_close → normal
 * 状态跨 chunk 保持，标签可跨 chunk 正确拆分。
 */

type ParserState = 'normal' | 'checking_open' | 'thinking' | 'checking_close'

/** 开始标签，7 个字符 */
const OPEN_TAG = '\x3Cthink\x3E'
/** 结束标签，8 个字符 */
const CLOSE_TAG = '\x3C/think\x3E'

export interface Segment {
  type: 'text' | 'thinking'
  content: string
}

export class ThinkTagParser {
  private state: ParserState = 'normal'
  private buffer = ''

  /** 处理一个文本 chunk，返回拆分后的片段（连续同类已合并） */
  feed(input: string): Segment[] {
    const segments: Segment[] = []
    for (let i = 0; i < input.length; i++) {
      this.processChar(input[i], segments)
    }
    return mergeSegments(segments)
  }

  /** 流结束时冲刷缓冲区，不完整标签内容不会丢失 */
  flush(): Segment[] {
    if (!this.buffer) return []
    const type = this.state === 'checking_open' ? 'text' : 'thinking'
    const result: Segment[] = [{ type, content: this.buffer }]
    this.buffer = ''
    this.state = 'normal'
    return result
  }

  private processChar(char: string, outputs: Segment[]): void {
    switch (this.state) {
      case 'normal':
        if (char === '<') {
          this.buffer = '<'
          this.state = 'checking_open'
        } else {
          outputs.push({ type: 'text', content: char })
        }
        break

      case 'checking_open': {
        this.buffer += char
        if (OPEN_TAG.startsWith(this.buffer)) {
          if (this.buffer === OPEN_TAG) {
            this.state = 'thinking'
            this.buffer = ''
          }
        } else {
          outputs.push({ type: 'text', content: this.buffer[0] })
          const rest = this.buffer.slice(1)
          this.buffer = ''
          this.state = 'normal'
          for (const c of rest) {
            this.processChar(c, outputs)
          }
        }
        break
      }

      case 'thinking':
        if (char === '<') {
          this.buffer = '<'
          this.state = 'checking_close'
        } else {
          outputs.push({ type: 'thinking', content: char })
        }
        break

      case 'checking_close': {
        this.buffer += char
        if (CLOSE_TAG.startsWith(this.buffer)) {
          if (this.buffer === CLOSE_TAG) {
            this.state = 'normal'
            this.buffer = ''
          }
        } else {
          outputs.push({ type: 'thinking', content: this.buffer[0] })
          const rest = this.buffer.slice(1)
          this.buffer = ''
          this.state = 'thinking'
          for (const c of rest) {
            this.processChar(c, outputs)
          }
        }
        break
      }
    }
  }
}

function mergeSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return []
  const merged: Segment[] = [{ ...segments[0] }]
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1]
    if (last.type === segments[i].type) {
      last.content += segments[i].content
    } else {
      merged.push({ ...segments[i] })
    }
  }
  return merged
}
