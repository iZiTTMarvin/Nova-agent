/**
 * 字节预算工具：沙箱值回传与 curated output 共用的 UTF-8 截断。
 * 指数回退粗截（不做多字节精确切分），避免逐字符扫描大字符串。
 */

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 截断到字节预算内并附加标记；标记本身计入预算 */
export function truncateToByteBudget(text: string, maxBytes: number, marker: string): string {
  if (byteLength(text) <= maxBytes) return text
  const budget = maxBytes - byteLength(marker)
  let end = text.length
  while (end > 0 && byteLength(text.slice(0, end)) > budget) {
    end = Math.floor(end / 2)
  }
  return text.slice(0, end) + marker
}
