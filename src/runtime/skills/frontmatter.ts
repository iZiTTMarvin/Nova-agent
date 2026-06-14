/**
 * SKILL.md frontmatter 解析与校验
 * YAML 层：yamlFrontmatter.ts（gray-matter + js-yaml）
 * 业务层：映射到 Nova SkillManifest，失败不抛异常
 */
import { existsSync, readdirSync } from 'fs'
import type { HookEvent } from '../agent/types'
import type { SkillManifest, SkillSource } from './types'
import {
  getYamlAgentField,
  getYamlBool,
  getYamlString,
  getYamlStringList,
  hasYamlField,
  parseYamlFrontmatter
} from './yamlFrontmatter'

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

/** v1 明确不实现的 Claude 扩展字段 */
const UNIMPLEMENTED_FIELDS = ['arguments', 'paths', 'shell', 'effort'] as const

export interface ParseSkillOptions {
  fallbackName: string
  source: SkillSource
  sourcePath: string
  directory: string
}

function parseHooksField(list: string[] | undefined, warnings: string[]): HookEvent[] | undefined {
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
    return readdirSync(directory, { withFileTypes: true })
      .some(e => e.isDirectory() || (e.isFile() && e.name !== 'SKILL.md'))
  } catch {
    return false
  }
}

function buildInvalidManifest(
  opts: ParseSkillOptions,
  body: string,
  warnings: string[],
  invalidReason: string
): SkillManifest {
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
    invalidReason
  }
}

/**
 * 解析 SKILL.md 全文为 SkillManifest
 */
export function parseSkillMarkdown(content: string, opts: ParseSkillOptions): SkillManifest {
  const warnings: string[] = []
  const parsed = parseYamlFrontmatter(content)

  // 有 --- 但 YAML 完全无法解析
  if (parsed === null) {
    const body = content.trim()
    warnings.push('frontmatter YAML 解析失败，已尝试宽松预处理')
    const description = firstParagraph(body)
    if (!description) {
      return buildInvalidManifest(opts, body, warnings, 'frontmatter YAML 解析失败且无法从正文推断 description')
    }
    return {
      name: opts.fallbackName,
      description,
      userInvocable: true,
      modelInvocable: true,
      body,
      source: opts.source,
      sourcePath: opts.sourcePath,
      directory: opts.directory,
      warnings,
      hasSupportingFiles: detectSupportingFiles(opts.directory),
      enabled: true,
      invalid: false
    }
  }

  const { data, body: rawBody, usedFallback } = parsed
  const body = rawBody.trim()
  const hasFrontmatter = Object.keys(data).length > 0

  if (usedFallback) {
    warnings.push('frontmatter 已使用宽松 YAML 预处理解析')
  }

  // 无 frontmatter 块
  if (!hasFrontmatter) {
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

  // name：校验 slug，失败降级目录名
  let name = getYamlString(data, 'name') || opts.fallbackName
  const rawName = getYamlString(data, 'name')
  if (rawName && !SLUG_RE.test(rawName)) {
    warnings.push(`name "${rawName}" 不是合法 slug，已降级为目录名 "${opts.fallbackName}"`)
    name = opts.fallbackName
  }

  // description：必填；可拼接 when_to_use
  let description = getYamlString(data, 'description') ?? ''
  const whenToUse = getYamlString(data, 'when_to_use')
  if (whenToUse) {
    description = description ? `${description} ${whenToUse}` : whenToUse
    warnings.push('when_to_use 已合并入 description')
  }
  if (!description) {
    description = firstParagraph(body)
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    warnings.push(`description 超过 ${MAX_DESCRIPTION_LEN} 字符，已截断`)
    description = description.slice(0, MAX_DESCRIPTION_LEN)
  }

  if (!description) {
    return buildInvalidManifest(opts, body, warnings, '缺少 description 且无法从正文推断')
  }

  const context = getYamlString(data, 'context')
  const forkAgent =
    getYamlBool(data, 'fork_agent', false) || context?.toLowerCase() === 'fork'

  for (const key of UNIMPLEMENTED_FIELDS) {
    if (hasYamlField(data, key)) {
      // S5：仅在 dev 环境下提示，避免生产环境向用户暴露内部实现细节（这些字段
      // 当前是 silently ignored，对用户无感）。开发期可借助 NODE_ENV !== production
      // 提示技能作者该字段未实现；生产环境直接静默忽略。
      if (process.env.NODE_ENV !== 'production') {
        warnings.push(`frontmatter 字段 "${key}" 在 v1 未实现，已忽略`)
      }
    }
  }

  return {
    name,
    nameZh: getYamlString(data, 'name_zh') ?? getYamlString(data, 'name-zh'),
    description,
    descriptionZh: getYamlString(data, 'description_zh') ?? getYamlString(data, 'description-zh'),
    userInvocable: getYamlBool(data, 'user-invocable', true),
    modelInvocable: !getYamlBool(data, 'disable-model-invocation', false),
    agent: getYamlAgentField(data, 'agent'),
    allowedTools: getYamlStringList(data, 'allowed-tools'),
    forbiddenTools:
      getYamlStringList(data, 'forbidden-tools') ?? getYamlStringList(data, 'disallowed-tools'),
    argumentHint: getYamlString(data, 'argument-hint'),
    hooks: parseHooksField(getYamlStringList(data, 'hooks'), warnings),
    forkAgent,
    subagentModel: getYamlString(data, 'model'),
    autoSummarize: getYamlBool(data, 'auto_summarize', getYamlBool(data, 'auto-summarize', false)),
    body,
    source: opts.source,
    sourcePath: opts.sourcePath,
    directory: opts.directory,
    warnings,
    hasSupportingFiles: detectSupportingFiles(opts.directory),
    enabled: true,
    invalid: false
  }
}
