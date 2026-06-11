/**
 * SKILL.md frontmatter 解析与校验
 * 失败不抛异常，错误写入 warnings / invalid 标记
 */
import { existsSync, readdirSync } from 'fs'
import type { HookEvent } from '../agent/types'
import type { SkillManifest, SkillSource } from './types'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_DESCRIPTION_LEN = 340
const VALID_HOOKS = new Set<HookEvent>([
  'onMessageStart',
  'beforeAgentStart',
  'preChat',
  'context',
  'preToolUse',
  'postToolUse',
  'postMessage',
  'onError',
  'onCancel'
])

export interface ParseSkillOptions {
  fallbackName: string
  source: SkillSource
  sourcePath: string
  directory: string
}

/** 解析 YAML-like frontmatter 行（不引入第三方包） */
function parseFrontmatterFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    fields[m[1]] = m[2].trim()
  }
  return fields
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  const v = value.toLowerCase()
  return v === 'true' || v === 'yes' || v === '1'
}

/** 解析逗号/空格分隔或简单 YAML 列表为 string[] */
function parseListField(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  const items = value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function parseAgentField(value: string | undefined): string | string[] | undefined {
  const list = parseListField(value)
  if (!list) return undefined
  return list.length === 1 ? list[0] : list
}

function parseHooksField(value: string | undefined, warnings: string[]): HookEvent[] | undefined {
  const list = parseListField(value)
  if (!list) return undefined
  const hooks: HookEvent[] = []
  for (const h of list) {
    if (VALID_HOOKS.has(h as HookEvent)) {
      hooks.push(h as HookEvent)
    } else {
      warnings.push(`未知 hook 事件 "${h}"，已忽略`)
    }
  }
  return hooks.length > 0 ? hooks : undefined
}

/** 从正文提取首段非标题文本作为 description 兜底 */
function firstParagraph(body: string): string {
  const parts: string[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t) {
      if (parts.length > 0) break
      continue
    }
    if (t.startsWith('#')) continue
    parts.push(t)
  }
  return parts.join(' ').slice(0, MAX_DESCRIPTION_LEN)
}

function detectSupportingFiles(directory: string): boolean {
  if (!existsSync(directory)) return false
  try {
    // 存在子目录，或除 SKILL.md 以外的文件 → 视为有附属资源
    return readdirSync(directory, { withFileTypes: true })
      .some(e => e.isDirectory() || (e.isFile() && e.name !== 'SKILL.md'))
  } catch {
    return false
  }
}

/**
 * 解析 SKILL.md 全文为 SkillManifest
 * @param content 文件全文
 * @param opts 目录名兜底与来源元数据
 */
export function parseSkillMarkdown(content: string, opts: ParseSkillOptions): SkillManifest {
  const warnings: string[] = []
  const match = content.match(FRONTMATTER_RE)

  // 无 frontmatter：整段当 body，尝试从正文提取 description
  if (!match) {
    const body = content.trim()
    const description = firstParagraph(body)
    const invalid = !description
    return {
      name: opts.fallbackName,
      description: description || opts.fallbackName,
      userInvocable: true,
      modelInvocable: true,
      body,
      source: opts.source,
      sourcePath: opts.sourcePath,
      directory: opts.directory,
      warnings: invalid ? [] : ['缺少 YAML frontmatter，已使用正文首段作为 description'],
      hasSupportingFiles: detectSupportingFiles(opts.directory),
      enabled: true,
      invalid,
      invalidReason: invalid ? '缺少 frontmatter 且无法从正文推断 description' : undefined
    }
  }

  const fields = parseFrontmatterFields(match[1])
  let body = match[2].trim()

  // name：校验 slug，失败降级目录名
  let name = fields.name || opts.fallbackName
  if (fields.name && !SLUG_RE.test(fields.name)) {
    warnings.push(`name "${fields.name}" 不是合法 slug，已降级为目录名 "${opts.fallbackName}"`)
    name = opts.fallbackName
  }

  // description：必填；可拼接 when_to_use
  let description = fields.description ?? ''
  if (fields.when_to_use) {
    description = description
      ? `${description} ${fields.when_to_use}`
      : fields.when_to_use
    warnings.push('when_to_use 已合并入 description')
  }
  if (!description) {
    description = firstParagraph(body)
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    warnings.push(`description 超过 ${MAX_DESCRIPTION_LEN} 字符，已截断`)
    description = description.slice(0, MAX_DESCRIPTION_LEN)
  }

  const invalid = !name && !description
  if (!description) {
    return {
      name: opts.fallbackName,
      description: '',
      userInvocable: true,
      modelInvocable: true,
      body,
      source: opts.source,
      sourcePath: opts.sourcePath,
      directory: opts.directory,
      warnings,
      hasSupportingFiles: detectSupportingFiles(opts.directory),
      enabled: true,
      invalid: true,
      invalidReason: '缺少 description 且无法从正文推断'
    }
  }

  // fork：支持 fork_agent 与 Claude 的 context: fork
  const forkAgent =
    parseBool(fields.fork_agent, false) ||
    fields.context?.toLowerCase() === 'fork'

  // 暂不实现的 Claude 字段
  for (const key of ['arguments', 'paths', 'shell', 'effort']) {
    if (fields[key]) {
      warnings.push(`frontmatter 字段 "${key}" 在 v1 未实现，已忽略`)
    }
  }

  return {
    name,
    nameZh: fields.name_zh || fields['name-zh'],
    description,
    descriptionZh: fields.description_zh || fields['description-zh'],
    userInvocable: parseBool(fields['user-invocable'], true),
    modelInvocable: !parseBool(fields['disable-model-invocation'], false),
    agent: parseAgentField(fields.agent),
    allowedTools: parseListField(fields['allowed-tools']),
    forbiddenTools: parseListField(fields['forbidden-tools'] ?? fields['disallowed-tools']),
    argumentHint: fields['argument-hint'],
    hooks: parseHooksField(fields.hooks, warnings),
    forkAgent,
    subagentModel: fields.model,
    autoSummarize: parseBool(fields.auto_summarize ?? fields['auto-summarize'], false),
    body,
    source: opts.source,
    sourcePath: opts.sourcePath,
    directory: opts.directory,
    warnings,
    hasSupportingFiles: detectSupportingFiles(opts.directory),
    enabled: true,
    invalid: invalid || false
  }
}
