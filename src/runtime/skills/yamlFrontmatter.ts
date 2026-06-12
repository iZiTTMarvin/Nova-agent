/**
 * YAML frontmatter 解析层
 * gray-matter + js-yaml 主路径；失败时用 fallbackSanitization 宽松重试
 * 注：gray-matter v4 维护较少，短期够用；若生态 YAML 需求变化再评估替换方案
 */
import matter from 'gray-matter'

export type YamlFrontmatterData = Record<string, unknown>

export interface YamlFrontmatterResult {
  data: YamlFrontmatterData
  body: string
  /** 是否经过 fallback 预处理 */
  usedFallback: boolean
}

const FRONTMATTER_DELIM_RE = /^---\r?\n/

/**
 * 兼容 Claude Code 等「类 YAML」frontmatter：
 * 对未引号且含冒号的值自动加双引号；缩进续行与 block scalar 标记保持不动
 */
export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content

  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result: string[] = []

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') {
      result.push(line)
      continue
    }

    // block scalar 续行 / 嵌套结构：保持原样
    if (/^\s+/.test(line)) {
      result.push(line)
      continue
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      result.push(line)
      continue
    }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()

    if (
      value === '' ||
      value === '>' ||
      value === '|' ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      result.push(line)
      continue
    }

    if (value.includes(':')) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      result.push(`${key}: "${escaped}"`)
      continue
    }

    result.push(line)
  }

  // 保留原 frontmatter 行尾风格（CRLF 文件 fallback 后仍为 CRLF）
  const lineSep = frontmatter.includes('\r\n') ? '\r\n' : '\n'
  return content.replace(frontmatter, () => result.join(lineSep))
}

function matterParse(content: string): YamlFrontmatterResult {
  const md = matter(content)
  return {
    data: (md.data ?? {}) as YamlFrontmatterData,
    body: md.content ?? '',
    usedFallback: false
  }
}

/**
 * 解析 SKILL.md 全文中的 YAML frontmatter
 * 无 `---` 分隔符时返回空 data + 全文 body（与 gray-matter 行为一致）
 */
export function parseYamlFrontmatter(content: string): YamlFrontmatterResult | null {
  if (!FRONTMATTER_DELIM_RE.test(content)) {
    return { data: {}, body: content, usedFallback: false }
  }

  try {
    return matterParse(content)
  } catch {
    try {
      const parsed = matterParse(fallbackSanitization(content))
      return { ...parsed, usedFallback: true }
    } catch {
      return null
    }
  }
}

/** 读取字符串字段（标量转 string） */
export function getYamlString(data: YamlFrontmatterData, key: string): string | undefined {
  const value = data[key]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** 读取布尔字段（支持 YAML 原生 boolean） */
export function getYamlBool(
  data: YamlFrontmatterData,
  key: string,
  defaultValue: boolean
): boolean {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if (v === 'true' || v === 'yes' || v === '1') return true
    if (v === 'false' || v === 'no' || v === '0') return false
  }
  return defaultValue
}

/** 读取字符串列表（YAML 数组或逗号/括号分隔字符串） */
export function getYamlStringList(data: YamlFrontmatterData, key: string): string[] | undefined {
  const value = data[key]
  if (Array.isArray(value)) {
    const items = value
      .map(item => (item === null || item === undefined ? '' : String(item).trim()))
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }

  const scalar = getYamlString(data, key)
  if (!scalar) return undefined

  if (scalar.startsWith('[') && scalar.endsWith(']')) {
    return scalar
      .slice(1, -1)
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }

  const items = scalar.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

/** agent 字段：字符串或列表 */
export function getYamlAgentField(
  data: YamlFrontmatterData,
  key: string
): string | string[] | undefined {
  const list = getYamlStringList(data, key)
  if (!list) return undefined
  return list.length === 1 ? list[0] : list
}

/** 字段是否存在（用于 v1 未实现字段告警） */
export function hasYamlField(data: YamlFrontmatterData, key: string): boolean {
  return data[key] !== undefined && data[key] !== null
}
