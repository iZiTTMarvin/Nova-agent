import type { SkillSource } from './types'

interface SkillIdentity {
  name: string
  source: SkillSource
  sourcePath: string
}

function normalizeSkillPath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const windows = /^[a-z]:\//i.test(slashed) || slashed.startsWith('//')
  const prefix = slashed.startsWith('//') ? '//' : slashed.startsWith('/') ? '/' : ''
  const segments: string[] = []
  for (const segment of slashed.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..' && segments.length > 0 && !segments.at(-1)?.endsWith(':')) segments.pop()
    else if (segment !== '..') segments.push(segment)
  }
  const normalized = prefix + segments.join('/')
  return windows ? normalized.toLowerCase() : normalized
}

/** 身份绑定当前来源、规范路径和工作区；同名替换不会继承许可。 */
export function createSkillId(skill: SkillIdentity, workspaceRoot?: string | null): string {
  return JSON.stringify([
    skill.name,
    skill.source,
    normalizeSkillPath(skill.sourcePath),
    workspaceRoot ? normalizeSkillPath(workspaceRoot) : ''
  ])
}

/** 设置读写共用的持久化身份校验与规范化。 */
export function normalizeSkillId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let parts: unknown
  try {
    parts = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parts) || parts.length !== 4) return null
  const [name, sourceValue, sourcePath, workspaceRoot]: unknown[] = parts
  if (typeof name !== 'string' || typeof sourceValue !== 'string' ||
    typeof sourcePath !== 'string' || typeof workspaceRoot !== 'string') return null
  const sources: readonly SkillSource[] = ['builtin', 'global', 'project', 'third_party', 'virtual', 'mcp']
  const source = sources.find(candidate => candidate === sourceValue)
  if (!name.trim() || !source || !/^(?:[a-z]:[\\/]|[\\/])/i.test(sourcePath)) return null
  if (workspaceRoot && !/^(?:[a-z]:[\\/]|[\\/])/i.test(workspaceRoot)) return null
  return createSkillId({ name, source, sourcePath }, workspaceRoot)
}
