import { describe, it, expect } from 'vitest'
import {
  fallbackSanitization,
  parseYamlFrontmatter,
  getYamlString
} from '../../../../src/runtime/skills/yamlFrontmatter'

describe('yamlFrontmatter', () => {
  it('标准 YAML frontmatter 解析', () => {
    const raw = `---
name: commit
description: Smart Git commit helper
---
# body
`
    const result = parseYamlFrontmatter(raw)
    expect(result).not.toBeNull()
    expect(getYamlString(result!.data, 'name')).toBe('commit')
    expect(result!.body).toContain('# body')
    expect(result!.usedFallback).toBe(false)
  })

  it('值内含未引号冒号时 fallback 后可解析', () => {
    const raw = `---
occupation: This man has the following occupation: Software Engineer
description: ok
---
body
`
    const sanitized = fallbackSanitization(raw)
    expect(sanitized).toContain('occupation: "This man has the following occupation: Software Engineer"')

    const result = parseYamlFrontmatter(raw)
    expect(getYamlString(result!.data, 'occupation')).toContain('Software Engineer')
  })

  it('需 fallback 的同一内容重复解析结果一致（目录重扫不得污染技能描述）', () => {
    const raw = `---
name: repeat-scan
description: Design guide: landing pages and dashboards
---
body
`
    const first = parseYamlFrontmatter(raw)
    const second = parseYamlFrontmatter(raw)
    expect(second).toEqual(first)
    expect(getYamlString(second!.data, 'description')).toBe('Design guide: landing pages and dashboards')
  })

  it('无 frontmatter 时返回空 data', () => {
    const result = parseYamlFrontmatter('# title\n\npara')
    expect(Object.keys(result!.data)).toHaveLength(0)
    expect(result!.body).toContain('para')
  })
})
