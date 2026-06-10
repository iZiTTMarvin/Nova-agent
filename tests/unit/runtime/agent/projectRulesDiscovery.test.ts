import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { discoverProjectRules, discoverProjectRulesFile } from '../../../../src/runtime/agent/projectRulesDiscovery'

describe('projectRulesDiscovery', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `nova-rules-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('优先读取 AGENTS.md', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'agents rules')
    writeFileSync(join(workspace, 'CLAUDE.md'), 'claude rules')
    expect(discoverProjectRules(workspace)).toBe('agents rules')
    expect(discoverProjectRulesFile(workspace)).toBe('AGENTS.md')
  })

  it('无 AGENTS.md 时读 CLAUDE.md', () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), 'claude only')
    expect(discoverProjectRules(workspace)).toBe('claude only')
  })

  it('最后回退 .cursorrules', () => {
    writeFileSync(join(workspace, '.cursorrules'), 'cursor rules')
    expect(discoverProjectRules(workspace)).toBe('cursor rules')
  })

  it('都不存在返回 null', () => {
    expect(discoverProjectRules(workspace)).toBeNull()
    expect(discoverProjectRulesFile(workspace)).toBeNull()
  })

  it('空文件返回 null', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '   ')
    expect(discoverProjectRules(workspace)).toBeNull()
  })
})
