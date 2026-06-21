import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { discoverProjectRules, discoverProjectRulesFile } from '../../../../src/runtime/agent/context/projectRulesDiscovery'

describe('projectRulesDiscovery', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `nova-rules-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('当前目录 AGENTS.md 可读', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'agents rules')
    const result = discoverProjectRules(workspace)
    expect(result?.text).toContain('agents rules')
    expect(result?.text).toContain('<!-- AGENTS.md (depth=0):')
    expect(discoverProjectRulesFile(workspace)).toBe('AGENTS.md')
  })

  it('monorepo packages/app 能加载 app 与 repo root 两层规则', () => {
    const root = join(workspace, 'repo')
    const appDir = join(root, 'packages', 'app')
    mkdirSync(appDir, { recursive: true })

    writeFileSync(join(root, 'CLAUDE.md'), 'root claude rules')
    writeFileSync(join(appDir, 'AGENTS.md'), 'app agents rules')

    const result = discoverProjectRules(appDir)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(2)
    expect(result!.text).toContain('app agents rules')
    expect(result!.text).toContain('root claude rules')
    expect(result!.text).toContain('<!-- AGENTS.md (depth=0):')
    expect(result!.text).toContain('<!-- CLAUDE.md (depth=2):')
    // depth 升序：app (0) 在 root (2) 之前
    expect(result!.text.indexOf('app agents')).toBeLessThan(result!.text.indexOf('root claude'))
  })

  it('相同内容两份文件只出现一次正文', () => {
    const root = join(workspace, 'root')
    const sub = join(root, 'sub')
    mkdirSync(sub, { recursive: true })

    const shared = 'shared rules content'
    writeFileSync(join(root, 'CLAUDE.md'), shared)
    writeFileSync(join(sub, 'AGENTS.md'), shared)

    const result = discoverProjectRules(sub)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(1)
    expect(result!.text.match(/shared rules content/g)).toHaveLength(1)
    // 保留最浅 depth=1 的 sub/AGENTS.md（sub 相对 sub workspace depth=0）
    expect(result!.segments[0].file).toBe('AGENTS.md')
    expect(result!.segments[0].depth).toBe(0)
  })

  it('都不存在返回 null', () => {
    expect(discoverProjectRules(workspace)).toBeNull()
    expect(discoverProjectRulesFile(workspace)).toBeNull()
  })

  it('空文件返回 null', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '   ')
    expect(discoverProjectRules(workspace)).toBeNull()
  })

  it('同目录多个规则文件均收集', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'agents')
    writeFileSync(join(workspace, '.cursorrules'), 'cursor')
    const result = discoverProjectRules(workspace)
    expect(result!.segments).toHaveLength(2)
    expect(result!.text).toContain('agents')
    expect(result!.text).toContain('cursor')
  })
})
