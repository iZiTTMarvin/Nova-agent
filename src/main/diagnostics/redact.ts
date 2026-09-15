/**
 * 诊断素材脱敏：密钥与凭据模式的机械屏蔽。
 *
 * 硬红线：诊断包不得携带任何凭据。配置摘要在结构上就不含 key；
 * 日志是自由文本，必须过这里的正则兜底。
 */

export const REDACTED = '***REDACTED***'

interface RedactRule {
  pattern: RegExp
  /** 命中后的替换模板；$1/$2 引用捕获组（保留字段名与引号结构） */
  replacement: string
}

const RULES: RedactRule[] = [
  // OpenAI/DeepSeek/GLM 风格 key：sk- 开头的长 token
  { pattern: /sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g, replacement: REDACTED },
  // Bearer 凭据
  { pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
  // Authorization 头
  { pattern: /(\bAuthorization["'\s:]*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1${REDACTED}` },
  // JSON 字段形态：apiKey / api_key / token
  { pattern: /("api_?[Kk]ey"\s*:\s*")[^"]{8,}(")/g, replacement: `$1${REDACTED}$2` },
  { pattern: /("token"\s*:\s*")[^"]{8,}(")/g, replacement: `$1${REDACTED}$2` }
]

/** 屏蔽文本中的凭据模式，保留周边结构（字段名、引号、头名）。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement)
  }
  return out
}
