export const MEMORY_SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
  /\bAuthorization:[ \t]*[^\r\n]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // 40 位 AWS secret 与 git SHA 字符集重叠，只在带键名时识别。
  /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S*/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}\b/gi,
  /^[A-Z][A-Z0-9_]{0,63}=\S+$/gm,
  /<private>[\s\S]*?<\/private>/gi
]

export function containsSensitiveMemoryText(text: string): boolean {
  return MEMORY_SENSITIVE_TEXT_PATTERNS.some(pattern => new RegExp(pattern.source, pattern.flags).test(text))
}
