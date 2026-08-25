/**
 * 子进程输出净化：ANSI/VT 控制序列剥离 + 回车覆盖式进度条折叠。
 *
 * 必须跨 chunk 安全：转义序列与多字节字符都会被 chunk 边界切断，
 * 所以用流式 TextDecoder + 字符级状态机，不能用无状态正则。
 * 回车折叠把 `\r` 重绘的进度条（docker pull / npm install）从巨量输出
 * 压到每个最终行一条文本；代价是行内文本必须缓冲到 `\n` 或流结束才可交付。
 * 一个实例对应一个流。
 */
export class StreamOutputSanitizer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  private escapeState: 'ground' | 'esc' | 'csi' | 'osc' = 'ground'
  /** 悬垂 `\r`：等下一字符判定是 `\r\n` 还是行覆盖（可能跨 chunk） */
  private pendingCR = false
  /** 自上一个 `\n` 以来未交付的行内文本（可能被后续 `\r` 整行丢弃） */
  private lineBuffer = ''

  /** 喂入原始字节，返回本次可交付的净化文本 */
  push(chunk: Buffer): string {
    return this.consume(this.decoder.decode(chunk, { stream: true }))
  }

  /** 流结束：flush 解码器与状态机残留，交还未换行的尾部行 */
  flush(): string {
    const out = this.consume(this.decoder.decode()) + this.lineBuffer
    this.lineBuffer = ''
    this.pendingCR = false
    this.escapeState = 'ground'
    return out
  }

  /** 整段净化（用于把已积累的文本一次性转化为净化形态） */
  static sanitize(text: string): string {
    const sanitizer = new StreamOutputSanitizer()
    return sanitizer.push(Buffer.from(text, 'utf-8')) + sanitizer.flush()
  }

  private consume(text: string): string {
    let out = ''
    for (const ch of text) out += this.step(ch)
    return out
  }

  /** 处理单个字符，返回本次可交付文本（多为空串，行文本到 `\n` 才交付） */
  private step(ch: string): string {
    // 悬垂 `\r` 先判定：后随 `\n` 是 CRLF，否则是行覆盖（丢弃未交付的行内文本）
    if (this.pendingCR) {
      this.pendingCR = false
      if (ch === '\n') {
        const out = this.lineBuffer + '\n'
        this.lineBuffer = ''
        return out
      }
      this.lineBuffer = ''
    }
    if (this.escapeState !== 'ground') return this.stepEscape(ch)
    return this.stepGround(ch)
  }

  private stepGround(ch: string): string {
    if (ch === '\x1b') {
      this.escapeState = 'esc'
      return ''
    }
    if (ch === '\n') {
      const out = this.lineBuffer + '\n'
      this.lineBuffer = ''
      return out
    }
    if (ch === '\r') {
      this.pendingCR = true
      return ''
    }
    const code = ch.codePointAt(0) ?? 0
    // 除 \n \r 外的 C0 控制与 DEL 丢弃；\t 与可见字符保留
    if (code === 0x09 || (code >= 0x20 && code !== 0x7f)) this.lineBuffer += ch
    return ''
  }

  private stepEscape(ch: string): string {
    if (this.escapeState === 'esc') {
      // `[` → CSI、`]` → OSC，其余按 ESC+单字符序列丢弃回 ground
      // （OSC 的 ESC \ 终结也走这里：`\` 直接回 ground，不会死锁在 osc 态）
      this.escapeState = ch === '[' ? 'csi' : ch === ']' ? 'osc' : 'ground'
      return ''
    }
    if (this.escapeState === 'csi') {
      const code = ch.codePointAt(0) ?? 0
      // 参数/中间字节（0x20–0x3F）继续收集；final 字节（0x40–0x7E）终结序列
      if (code >= 0x20 && code <= 0x3f) return ''
      if (code >= 0x40 && code <= 0x7e) {
        this.escapeState = 'ground'
        return ''
      }
      // 序列残缺（C0 / 非 ASCII 混入）：终止序列，字符按 ground 规则处理，不吞正文
      if (ch === '\x1b') {
        this.escapeState = 'esc'
        return ''
      }
      this.escapeState = 'ground'
      return this.stepGround(ch)
    }
    // OSC 态：丢弃直到 BEL(0x07)；ESC 转入 esc 态等下一字符判定（含 ESC \ 终结）
    if (ch === '\x07') this.escapeState = 'ground'
    else if (ch === '\x1b') this.escapeState = 'esc'
    return ''
  }
}
