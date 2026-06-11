#!/usr/bin/env node
/**
 * 校验仓库内 .nova/skills 下各子目录的 SKILL.md frontmatter
 * 用法：node scripts/validate-skill-frontmatter.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SKILLS_ROOT = join(ROOT, '.nova', 'skills')

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_DESCRIPTION_LEN = 340

/** 解析 YAML-like frontmatter 行 */
function parseFields(raw) {
  const fields = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (m) fields[m[1]] = m[2].trim()
  }
  return fields
}

/** 校验单个 SKILL.md，返回 { errors, warnings } */
function validateSkillFile(filePath, dirName) {
  const errors = []
  const warnings = []
  const content = readFileSync(filePath, 'utf-8')
  const match = content.match(FRONTMATTER_RE)

  if (!match) {
    warnings.push('缺少 YAML frontmatter')
    return { errors, warnings, invalid: false }
  }

  const fields = parseFields(match[1])
  const name = fields.name || dirName

  if (fields.name && !SLUG_RE.test(fields.name)) {
    warnings.push(`name "${fields.name}" 不是合法 slug，运行时将降级为目录名`)
  }

  let description = fields.description ?? ''
  if (fields.when_to_use) {
    description = description ? `${description} ${fields.when_to_use}` : fields.when_to_use
    warnings.push('when_to_use 已合并入 description')
  }

  if (!description) {
    errors.push('缺少 description（且无 when_to_use）')
  } else if (description.length > MAX_DESCRIPTION_LEN) {
    warnings.push(`description 超过 ${MAX_DESCRIPTION_LEN} 字符`)
  }

  if (!name && !description) {
    errors.push('invalid: 无 name 且无 description')
  }

  return { errors, warnings, invalid: errors.some(e => e.startsWith('invalid')) }
}

/** 递归收集所有 SKILL.md */
function collectSkillFiles(dir) {
  const results = []
  if (!existsSync(dir)) return results

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (['node_modules', '.git', '.archive'].includes(entry.name)) continue

    const skillDir = join(dir, entry.name)
    const skillPath = join(skillDir, 'SKILL.md')
    if (existsSync(skillPath)) {
      results.push({ path: skillPath, dirName: entry.name })
    }
  }
  return results
}

function main() {
  const files = collectSkillFiles(SKILLS_ROOT)
  if (files.length === 0) {
    console.error(`未找到技能文件：${SKILLS_ROOT}`)
    process.exit(1)
  }

  let hasInvalid = false
  let totalWarnings = 0

  for (const { path, dirName } of files) {
    const rel = path.replace(ROOT + '\\', '').replace(ROOT + '/', '')
    const { errors, warnings, invalid } = validateSkillFile(path, dirName)

    if (errors.length === 0 && warnings.length === 0) {
      console.log(`✓ ${rel}`)
      continue
    }

    if (invalid) hasInvalid = true
    totalWarnings += warnings.length

    console.log(`${invalid ? '✗' : '⚠'} ${rel}`)
    for (const e of errors) console.log(`  ERROR: ${e}`)
    for (const w of warnings) console.log(`  WARN:  ${w}`)
  }

  console.log(`\n共 ${files.length} 个技能，${totalWarnings} 条警告`)
  if (hasInvalid) {
    console.error('存在 invalid 技能，校验失败')
    process.exit(1)
  }
  console.log('校验通过')
}

main()
