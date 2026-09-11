/**
 * 图片块的预算 token 计量：只对「有可靠依据的具体模型族」返回规则值，
 * 其余模型返回 null，调用方维持原有 URL 文本估算（保守高估方向，零行为变化）。
 *
 * 当前规则与依据：
 * - minimax-m3：官方 2016px / 14px patch 网格上限 + 576 全局预留（既有规则原样保留）。
 *   该定额是文档上限，命中范围放宽无碍——只会高估不会低估。
 * - qwen3.7-plus：官方 28px 合并 patch（14px patch × 2×2 merge），
 *   tokens = snap28(h) × snap28(w) / 784；像素上限 1536 token 对应档以本仓真实测量
 *   校准（Qwen/Qwen3.7-Plus，1920×911 PNG 实测 prompt 增量 ≈1.5k 量级）。该上限是
 *   部署相关的实测值而非通用常量：其他 qwen 型号/部署若允许更高像素预算，套用同一
 *   上限会低估预算，故未实测的 qwen 一律保持原口径。
 *   解析不出尺寸的图（远程 URL、非常见格式）回退到上限定额，保证不低估。
 * - 其余模型（含 qwen-vl-*、qwen3.5 等未实测代际）：无可靠依据，返回 null 保持原口径。
 */

/** 解析 data URL 图片真实尺寸；非 data URL、非常见格式或头部不完整返回 null。 */
export function parseImageDataUrlSize(url: string): { width: number; height: number } | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const meta = url.slice(5, comma)
  if (!/^image\//i.test(meta) || !/base64/i.test(meta)) return null
  // 头部约 6KB 足以覆盖各格式的尺寸字段
  const head = Buffer.from(url.slice(comma + 1, comma + 1 + 8192), 'base64')
  if (head.length < 32) return null

  // PNG：8 字节签名后 IHDR chunk，宽/高为大端 u32 @16/@20
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    if (head.readUInt32BE(12) !== 0x49484452) return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  }

  // JPEG：FFD8 后逐段扫描，SOF0-CF（除 C4/C8/CC）内含高/宽大端 u16
  if (head[0] === 0xff && head[1] === 0xd8) {
    let off = 2
    while (off + 9 < head.length) {
      if (head[off] !== 0xff) { off++; continue }
      const marker = head[off + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: head.readUInt16BE(off + 5), width: head.readUInt16BE(off + 7) }
      }
      const len = head.readUInt16BE(off + 2)
      if (len < 2) return null
      off += 2 + len
    }
    return null
  }

  // GIF：'GIF8' 签名，宽/高小端 u16 @6/@8
  if (head.toString('latin1', 0, 3) === 'GIF') {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
  }

  // BMP：'BM' 签名，宽/高小端 i32 @18/@22（高可为负表示自上而下）
  if (head[0] === 0x42 && head[1] === 0x4d) {
    const w = head.readInt32LE(18)
    const h = head.readInt32LE(22)
    return w > 0 ? { width: w, height: Math.abs(h) } : null
  }

  // WebP：RIFF....WEBP，按 VP8X / VP8（有损）/ VP8L（无损）三种子块解析
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    const fmt = head.toString('latin1', 12, 16)
    if (fmt === 'VP8X') {
      return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) }
    }
    if (fmt === 'VP8 ') {
      const w = head.readUInt16LE(26) & 0x3fff
      const h = head.readUInt16LE(28) & 0x3fff
      return w > 0 ? { width: w, height: h } : null
    }
    if (fmt === 'VP8L') {
      const b0 = head[21]!, b1 = head[22]!, b2 = head[23]!, b3 = head[24]!
      const w = (((b1 & 0x3f) << 8) | b0) + 1
      const h = (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) + 1
      return { width: w, height: h }
    }
  }
  return null
}

const QWEN_GRID_PX = 28
const QWEN_TOKEN_CAP = 1536
const QWEN_MAX_PIXELS = QWEN_TOKEN_CAP * QWEN_GRID_PX * QWEN_GRID_PX
const QWEN_MIN_PIXELS = 4 * QWEN_GRID_PX * QWEN_GRID_PX

function qwenImageTokens(size: { width: number; height: number } | null): number {
  if (!size || size.width <= 0 || size.height <= 0) return QWEN_TOKEN_CAP
  const pixels = size.width * size.height
  const scale = pixels > QWEN_MAX_PIXELS
    ? Math.sqrt(QWEN_MAX_PIXELS / pixels)
    : pixels < QWEN_MIN_PIXELS ? Math.sqrt(QWEN_MIN_PIXELS / pixels) : 1
  const snap = (v: number) => Math.max(QWEN_GRID_PX, Math.round((v * scale) / QWEN_GRID_PX) * QWEN_GRID_PX)
  return Math.round((snap(size.height) * snap(size.width)) / (QWEN_GRID_PX * QWEN_GRID_PX))
}

/** 命中规则返回该图的预算 token；未命中返回 null。 */
export function estimateImageBlockBudgetTokens(modelId: string | undefined, imageUrl: string): number | null {
  const rule = resolveImageBudgetRule(modelId)
  return rule ? rule(imageUrl) : null
}

/** 按模型 id 解析图片预算规则；无可靠规则返回 null（调用方保持原口径）。
 *  中继/聚合端点常见 `厂商/模型` 命名空间（如 MiniMaxAI/MiniMax-M3），按最后一段匹配。 */
export function resolveImageBudgetRule(modelId: string | undefined): ((imageUrl: string) => number) | null {
  if (!modelId) return null
  if (/(?:^|\/)minimax-m3(?:$|[-_])/i.test(modelId)) {
    // M3 的最大 2016px / 14px patch 网格；不抵扣模型的 2x2 patch 合并，另预留全局图。
    const reserve = (2016 / 14) ** 2 + 576
    return () => reserve
  }
  // 1536 token 上限只在 qwen3.7-plus 上有实测依据；其余 qwen 代际/部署不套用它，
  // 保持原口径（高估方向）。命中的型号名允许日期等尾缀（如 qwen3.7-plus-0906）。
  if (/(?:^|\/)qwen3\.7-plus(?:$|[-_.])/i.test(modelId)) {
    return (imageUrl) => qwenImageTokens(parseImageDataUrlSize(imageUrl))
  }
  return null
}
