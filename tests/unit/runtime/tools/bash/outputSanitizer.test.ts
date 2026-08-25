/**
 * outputSanitizer 单元测试
 *
 * 重点：跨 chunk 安全——转义序列、多字节字符与悬垂 `\r` 都会被
 * chunk 边界切断，任何切法都不能产生乱码或丢失折叠语义。
 */
import { describe, it, expect } from 'vitest'
import { StreamOutputSanitizer } from '@runtime/tools/bash/outputSanitizer'

/** 按给定 chunk 顺序整流，返回 push + flush 的完整净化文本 */
function runChunks(chunks: Array<string | Buffer>): string {
  const sanitizer = new StreamOutputSanitizer()
  let out = ''
  for (const chunk of chunks) {
    out += sanitizer.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk)
  }
  return out + sanitizer.flush()
}

describe('StreamOutputSanitizer', () => {
  it('CSI 序列被 chunk 切断（ESC 与 [ 分开、参数与 final 分开）仍完整剥离', () => {
    // 防：逐 chunk 无状态处理时把半截转义序列当正文输出，乱码进入文本
    expect(runChunks(['\x1b', '[', '9', '2m', 'dim ', '\x1b[0m', 'text\n'])).toBe('dim text\n')
  })

  it('OSC 标题序列剥离：BEL 与 ESC \\ 两种终结（终结符也可跨 chunk）', () => {
    // 防：OSC 只认 BEL 时 ESC \ 终结的序列吞掉后续正文，或序列内容泄进文本
    expect(runChunks(['\x1b]0;', 'window title', '\x07', 'body\n'])).toBe('body\n')
    expect(runChunks(['\x1b]2;title', '\x1b', '\\', 'body\n'])).toBe('body\n')
  })

  it('回车折叠：单独 \\r 是行覆盖，\\r\\n 规范为 \\n，行覆盖跨 chunk 同样成立', () => {
    // 防：docker pull / npm install 式进度重绘把巨量中间态灌进输出
    expect(StreamOutputSanitizer.sanitize('Set-Outcome 10%\rSet-Outcome 99%\n'))
      .toBe('Set-Outcome 99%\n')
    expect(StreamOutputSanitizer.sanitize('a\r\nb')).toBe('a\nb')
    expect(runChunks(['Set-Outcome 10%', '\r', 'Set-Outcome 99%', '\n']))
      .toBe('Set-Outcome 99%\n')
    expect(runChunks(['A', '\r', 'BB', '\r', 'CCC', '\n'])).toBe('CCC\n')
  })

  it('悬垂 \\r 在 chunk 尾：下一 chunk 以 \\n 开头按 CRLF，以普通字符开头按行覆盖', () => {
    // 防：chunk 尾的 \\r 被立即当成行覆盖吞掉行文本，或误判成 CRLF 丢失换行
    expect(runChunks(['done', '\r', '\nnext\n'])).toBe('done\nnext\n')
    expect(runChunks(['hidden', '\r', 'final line\n'])).toBe('final line\n')
  })

  it('中文多字节字符跨 chunk 不撕裂', () => {
    // 防：在 UTF-8 序列中间切开时出现 U+FFFD 替换符
    const buf = Buffer.from('中文字符跨块安全\n', 'utf-8')
    expect(runChunks([buf.subarray(0, 2), buf.subarray(2, 7), buf.subarray(7)]))
      .toBe('中文字符跨块安全\n')
  })

  it('除 \\n \\r \\t 外的 C0 控制字符丢弃，制表符保留', () => {
    expect(StreamOutputSanitizer.sanitize('a\x00\x08\x07b\tc\n')).toBe('ab\tc\n')
  })

  it('整段 sanitize 与逐 chunk push+flush 结果一致（任意字节边界切开）', () => {
    // 防：sanitize 与流式路径语义漂移，或某个特定切点产生与整段不同的输出
    const sample = '中文\x1b[32m彩色\x1b[0m段落\n进度 10%\r进度 99%\n\x1b]0;窗口标题\x07正文\r\n结尾\t行'
    const expected = '中文彩色段落\n进度 99%\n正文\n结尾\t行'
    expect(StreamOutputSanitizer.sanitize(sample)).toBe(expected)

    const buf = Buffer.from(sample, 'utf-8')
    for (let i = 0; i <= buf.byteLength; i++) {
      expect(runChunks([buf.subarray(0, i), buf.subarray(i)])).toBe(expected)
    }
  })
})
