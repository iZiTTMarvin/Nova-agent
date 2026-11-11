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

/** 身份绑定当前来源与规范路径；仅项目级来源额外绑定工作区，避免全局与内置许可跨工作区失效。 */
export function createSkillId(skill: SkillIdentity, workspaceRoot?: string | null): string {
  const normalizedSource = normalizeSkillPath(skill.sourcePath)
  const normalizedRoot = workspaceRoot ? normalizeSkillPath(workspaceRoot) : ''
  const scopedWorkspace =
    skill.source === 'project'
      ? normalizedRoot
      : skill.source === 'third_party' &&
          normalizedRoot !== '' &&
          (normalizedRoot === '/'
            ? normalizedSource.startsWith('/')
            : normalizedSource.startsWith(`${normalizedRoot}/`))
        ? normalizedRoot
        : ''
  return JSON.stringify([
    skill.name,
    skill.source,
    normalizedSource,
    scopedWorkspace
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
