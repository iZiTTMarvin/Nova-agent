/**
 * projectRulesDiscovery — 从 workspaceRoot 向上发现项目规则文件
 *
 * 收集 AGENTS.md / CLAUDE.md / .cursorrules，按 depth 升序，
 * 字节级去重（相同内容只保留最浅的一份）。
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'

/** 规则文件名（各目录均可存在，向上合并） */
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const

/** 单段规则元数据 */
export interface ProjectRulesSegment {
  file: string
  depth: number
  absolutePath: string
  content: string
}

/** 向上发现结果 */
export interface ProjectRulesResult {
  /** 拼接后的规则正文（含 depth 注释） */
  text: string
  segments: ProjectRulesSegment[]
}

interface RawSegment extends ProjectRulesSegment {
  /** 内容哈希键（字节级去重用） */
  contentKey: string
}

/** 从 workspaceRoot 向上遍历直到文件系统根 */
function* walkUpDirectories(startDir: string): Generator<{ dir: string; depth: number }> {
  let current = resolve(startDir)
  let depth = 0
  const seen = new Set<string>()

  while (true) {
    if (seen.has(current)) break
    seen.add(current)
    yield { dir: current, depth }

    const parent = dirname(current)
    if (parent === current) break
    current = parent
    depth++
  }
}

/** 读取单个规则文件；不存在或空文件返回 null */
function readRuleFile(dir: string, file: string): string | null {
  const fullPath = join(dir, file)
  if (!existsSync(fullPath)) return null
  try {
    const content = readFileSync(fullPath, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

/** 格式化单段规则（含 HTML 注释标头） */
function formatSegment(segment: ProjectRulesSegment): string {
  return `<!-- ${segment.file} (depth=${segment.depth}): ${segment.absolutePath} -->\n${segment.content}`
}

/**
 * 从 workspaceRoot 向上发现项目规则。
 * 无规则文件时返回 null。
 */
export function discoverProjectRules(workspaceRoot: string): ProjectRulesResult | null {
  const raw: RawSegment[] = []

  for (const { dir, depth } of walkUpDirectories(workspaceRoot)) {
    for (const file of RULE_FILES) {
      const content = readRuleFile(dir, file)
      if (!content) continue
      raw.push({
        file,
        depth,
        absolutePath: join(dir, file),
        content,
        contentKey: content
      })
    }
  }

  if (raw.length === 0) return null

  // 按 depth 升序；同 depth 按 RULE_FILES 顺序
  raw.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    return RULE_FILES.indexOf(a.file as typeof RULE_FILES[number]) -
      RULE_FILES.indexOf(b.file as typeof RULE_FILES[number])
  })

  // 字节级去重：相同 content 只保留 depth 最浅（已排序，首次出现即最浅）
  const seenContent = new Set<string>()
  const segments: ProjectRulesSegment[] = []

  for (const item of raw) {
    if (seenContent.has(item.contentKey)) continue
    seenContent.add(item.contentKey)
    segments.push({
      file: item.file,
      depth: item.depth,
      absolutePath: item.absolutePath,
      content: item.content
    })
  }

  if (segments.length === 0) return null

  const text = segments.map(formatSegment).join('\n\n')
  return { text, segments }
}

/** 返回最浅层命中的规则文件名（测试 / 诊断用） */
export function discoverProjectRulesFile(workspaceRoot: string): string | null {
  const result = discoverProjectRules(workspaceRoot)
  if (!result || result.segments.length === 0) return null
  return result.segments[0].file
}
