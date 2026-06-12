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

  it('无 frontmatter 时返回空 data', () => {
    const result = parseYamlFrontmatter('# title\n\npara')
    expect(Object.keys(result!.data)).toHaveLength(0)
    expect(result!.body).toContain('para')
  })
})
