/**
 * PrivacyFilter — 采集前隐私剥离（纯逻辑，fail-closed）
 *
 * 在任何 observation 持久化/缓冲之前强制过滤；命中敏感路径或无法安全过滤时丢弃整条采集。
 */

/** 敏感内容替换占位（测试断言用此常量，勿嵌入真实密钥） */
export const PRIVACY_REDACTED = '[REDACTED]'

export interface PrivacyFilterOptions {
  /** tool 输出最大字符数，超出截断 */
  maxOutputChars?: number
}

export interface PrivacyFilterResult {
  text: string
  /** 是否命中并剥离了敏感模式 */
  hadSensitive: boolean
  /** fail-closed：为 true 时上层应丢弃整条 observation */
  shouldDiscard: boolean
  /** 输出是否被截断 */
  truncated: boolean
}

const DEFAULT_MAX_OUTPUT_CHARS = 8 * 1024

/** 敏感文件路径（.env / 私钥等），命中则不采集 */
const SENSITIVE_FILE_RE =
  /(?:^|\/)\.env(?:\.|$)|(?:^|\/)credentials\.json$|\.(?:pem|key|p12|pfx)$|(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/i

/** OpenAI / 常见 API key */
const SK_KEY_RE = /\bsk-[a-zA-Z0-9]{16,}\b/g
/** AWS Access Key */
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g
/** Bearer token */
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}\b/gi
/** GitHub PAT */
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
/** Slack token */
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
/** 通用长 hex/base64 秘钥形态（保守匹配） */
const GENERIC_SECRET_RE = /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}\b/gi
/** .env 风格 KEY=VALUE（全行） */
const ENV_LINE_RE = /^[A-Z][A-Z0-9_]{0,63}=\S+$/gm
/** <private>...</private> 整段 */
const PRIVATE_BLOCK_RE = /<private>[\s\S]*?<\/private>/gi

const ALL_PATTERNS: RegExp[] = [
  SK_KEY_RE,
  AWS_KEY_RE,
  BEARER_RE,
  GITHUB_TOKEN_RE,
  SLACK_TOKEN_RE,
  GENERIC_SECRET_RE,
  ENV_LINE_RE,
  PRIVATE_BLOCK_RE
]

/**
 * 判断文件路径是否属于禁止采集的敏感文件
 */
export function isSensitiveFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').trim()
  if (!normalized) {
    return false
  }
  return SENSITIVE_FILE_RE.test(normalized)
}

/**
 * 过滤文本中的敏感模式；命中 .env 整段内容时 fail-closed 丢弃
 */
export function filterPrivacyText(
  text: string,
  options: PrivacyFilterOptions = {}
): PrivacyFilterResult {
  if (!text) {
    return { text: '', hadSensitive: false, shouldDiscard: false, truncated: false }
  }

  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  let hadSensitive = false
  let shouldDiscard = false
  let working = text

  // 整段像 .env 文件（多行 KEY=VALUE）→ 不采集
  const envLines = working.split('\n').filter((line) => /^[A-Z][A-Z0-9_]{0,63}=\S+$/.test(line.trim()))
  if (envLines.length >= 2) {
    return {
      text: '',
      hadSensitive: true,
      shouldDiscard: true,
      truncated: false
    }
  }

  for (const pattern of ALL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    if (re.test(working)) {
      hadSensitive = true
      working = working.replace(new RegExp(pattern.source, pattern.flags), PRIVACY_REDACTED)
    }
  }

  // 过滤后仍残留高风险形态 → 丢弃
  if (containsUnfilteredSecret(working)) {
    shouldDiscard = true
    working = ''
  }

  let truncated = false
  if (working.length > maxChars) {
    working = working.slice(0, maxChars) + '\n…[truncated]'
    truncated = true
  }

  return { text: working, hadSensitive, shouldDiscard, truncated }
}

/** 过滤后是否仍含未剥离的密钥形态 */
function containsUnfilteredSecret(text: string): boolean {
  if (!text) {
    return false
  }
  const probes = [SK_KEY_RE, AWS_KEY_RE, BEARER_RE, GITHUB_TOKEN_RE, SLACK_TOKEN_RE]
  for (const p of probes) {
    const re = new RegExp(p.source, p.flags)
    if (re.test(text)) {
      return true
    }
  }
  return false
}

/**
 * 合并过滤 tool 输入/输出；任一 shouldDiscard 或敏感路径则整条丢弃
 */
export function filterToolPayload(
  toolInput: string,
  toolOutput: string,
  filesTouched: string[],
  options?: PrivacyFilterOptions
): {
  filteredInput: string
  filteredOutput: string
  shouldDiscard: boolean
  hadSensitive: boolean
} {
  if (filesTouched.some(isSensitiveFilePath)) {
    return {
      filteredInput: '',
      filteredOutput: '',
      shouldDiscard: true,
      hadSensitive: true
    }
  }

  const inResult = filterPrivacyText(toolInput, options)
  const outResult = filterPrivacyText(toolOutput, options)

  if (inResult.shouldDiscard || outResult.shouldDiscard) {
    return {
      filteredInput: '',
      filteredOutput: '',
      shouldDiscard: true,
      hadSensitive: true
    }
  }

  return {
    filteredInput: inResult.text,
    filteredOutput: outResult.text,
    shouldDiscard: false,
    hadSensitive: inResult.hadSensitive || outResult.hadSensitive
  }
}
