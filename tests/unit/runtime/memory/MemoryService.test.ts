import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryService } from '../../../../src/runtime/memory/MemoryService'
import { computeWorkspaceHash, getMemoryRoot, getProjectMemoryDir } from '../../../../src/runtime/memory/MemoryPaths'
import { truncateAtLineOrHeaderBoundary } from '../../../../src/runtime/memory/truncateEssence'

describe('truncateAtLineOrHeaderBoundary', () => {
  it('未超限返回原文', () => {
    const text = 'line one\nline two'
    expect(truncateAtLineOrHeaderBoundary(text, 100)).toBe(text)
  })

  it('超限时不在行内截断', () => {
    const line = 'a'.repeat(50)
    const text = `${line}\n${line}\n${line}`
    const out = truncateAtLineOrHeaderBoundary(text, 60)
    expect(out.length).toBeLessThanOrEqual(60)
    const originalLines = text.split('\n')
    for (const part of out.split('\n')) {
      expect(originalLines).toContain(part)
    }
  })

  it('优先在 Markdown 标题边界截断', () => {
    const text = [
      'intro line',
      '## Section A',
      'content a',
      '## Section B',
      'content b is long'
    ].join('\n')
    const out = truncateAtLineOrHeaderBoundary(text, 15)
    expect(out).toBe('intro line')
    expect(out).not.toContain('Section B')
  })
})

describe('MemoryService.appendEpisodicSummary', () => {
  let userData: string
  let memoryRoot: string
  let scopeId: string
  let service: MemoryService

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'nova-mem-append-'))
    const workspace = join(userData, 'ws')
    mkdirSync(workspace, { recursive: true })
    memoryRoot = getMemoryRoot(userData)
    scopeId = computeWorkspaceHash(workspace)
    service = new MemoryService(memoryRoot)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('追加 episodic/summary.md 不覆盖已有内容', () => {
    const block1 = '## block one\n\n---\n'
    const block2 = '## block two\n\n---\n'
    service.appendEpisodicSummary(scopeId, block1)
    service.appendEpisodicSummary(scopeId, block2)
    const content = service.readScopeFile(scopeId, 'episodic/summary.md')
    expect(content).toContain('block one')
    expect(content).toContain('block two')
  })

  it('MEMORY.md 不被 append 方法触及', () => {
    const dir = getProjectMemoryDir(memoryRoot, scopeId)
    mkdirSync(dir, { recursive: true })
    const memoryBody = '# 用户手写精华'
    writeFileSync(join(dir, 'MEMORY.md'), memoryBody, 'utf8')
    service.appendEpisodicSummary(scopeId, '## episodic\n')
    expect(service.readScopeFile(scopeId, 'MEMORY.md')).toBe(memoryBody)
  })
})
