/**
 * SkillManifest — 技能 frontmatter 解析与类型定义
 */
import type { HookEvent } from '../agent/types'

/** 技能清单结构 */
export interface SkillManifest {
  /** 技能唯一标识 */
  name: string
  /** 模型可见的一句话简介 */
  description: string
  /** 是否允许 /name slash 调用 */
  userInvocable: boolean
  /** 是否允许模型自动选用 */
  modelInvocable: boolean
  /** 技能正文（不含 frontmatter） */
  body: string
  /**
   * 可选 hook 声明（第二版：解析后注册到 HookManager，第一版仅 schema 预留）
   * @see tasks/hook-system-implementation.md 阶段 2.1
   */
  hooks?: HookEvent[]
  /** 可选工具白名单 */
  allowedTools?: string[]
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** 解析 YAML-like frontmatter（不引入第三方包） */
function parseFrontmatterFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    fields[m[1]] = m[2].trim()
  }
  return fields
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return value === 'true' || value === 'yes'
}

/**
 * 解析 SKILL.md 全文为 SkillManifest
 * @param content 文件全文
 * @param fallbackName 目录名兜底
 */
export function parseSkillMarkdown(content: string, fallbackName: string): SkillManifest | null {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return null

  const fields = parseFrontmatterFields(match[1])
  const name = fields.name || fallbackName
  const description = fields.description
  if (!name || !description) return null

  return {
    name,
    description,
    userInvocable: parseBool(fields['user-invocable'], true),
    // disable-model-invocation: true 时禁止模型自动选用
    modelInvocable: fields['disable-model-invocation'] !== 'true',
    body: match[2].trim()
  }
}
