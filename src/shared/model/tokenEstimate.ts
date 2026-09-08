/**
 * 未知 tokenizer 的文本估算，不作为供应商实测或严格上界。
 * 分档偏高一档留余量：CJK 实测约 0.6–0.8，取 1 既不低估也不会让中文会话过早压缩。
 */
export function estimateTextTokens(text: string): number {
  let units = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    units += point <= 0x7f ? 0.25 : point <= 0xffff ? 1 : 2
  }
  return Math.ceil(units)
}
