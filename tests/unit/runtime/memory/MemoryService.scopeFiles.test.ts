/**
 * MemoryService scope 文件读写与路径穿越防护
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryService } from '../../../../src/runtime/memory/MemoryService'
import { computeWorkspaceHash, getMemoryRoot, getProjectMemoryDir } from '../../../../src/runtime/memory/MemoryPaths'
import { resolveSafeScopeRelPath } from '../../../../src/runtime/memory/MemoryPaths'

describe('resolveSafeScopeRelPath', () => {
  const scopeDir = join(tmpdir(), 'nova-scope-safe')

  it('合法相对路径可解析', () => {
    const abs = resolveSafeScopeRelPath(scopeDir, 'MEMORY.md')
    expect(abs).toContain('MEMORY.md')
  })

  it('拒绝 ../ 路径穿越', () => {
    expect(() => resolveSafeScopeRelPath(scopeDir, '../escape.md')).toThrow(/穿越|超出/)
    expect(() => resolveSafeScopeRelPath(scopeDir, 'sub/../../outside.md')).toThrow(/穿越|超出/)
  })

  it('拒绝绝对路径与非 .md', () => {
    expect(() => resolveSafeScopeRelPath(scopeDir, '/etc/passwd')).toThrow()
    expect(() => resolveSafeScopeRelPath(scopeDir, 'notes.txt')).toThrow(/\.md/)
  })
})

describe('MemoryService scope 文件 API', () => {
  let userData: string
  let memoryRoot: string
  let scopeId: string
  let service: MemoryService

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'nova-mem-scope-'))
    const workspace = join(userData, 'ws')
    mkdirSync(workspace, { recursive: true })
    memoryRoot = getMemoryRoot(userData)
    scopeId = computeWorkspaceHash(workspace)
    service = new MemoryService(memoryRoot)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('listScopeFiles 返回相对路径 + size + mtime', () => {
    const dir = getProjectMemoryDir(memoryRoot, scopeId)
    mkdirSync(join(dir, 'episodic'), { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '# 主记忆', 'utf8')
    writeFileSync(join(dir, 'episodic', 'summary.md'), '摘要', 'utf8')

    const files = service.listScopeFiles(scopeId)
    expect(files).toHaveLength(2)
    const paths = files.map((f) => f.relPath).sort()
    expect(paths).toEqual(['MEMORY.md', 'episodic/summary.md'])
    for (const f of files) {
      expect(f.size).toBeGreaterThan(0)
      expect(f.mtimeMs).toBeGreaterThan(0)
    }
  })

  it('readScopeFile 可读单个 md', () => {
    service.upsertMarkdown(scopeId, 'MEMORY.md', 'hello memory')
    expect(service.readScopeFile(scopeId, 'MEMORY.md')).toBe('hello memory')
  })

  it('upsertMarkdown 拒绝路径穿越', () => {
    expect(() => service.upsertMarkdown(scopeId, '../evil.md', 'x')).toThrow()
  })

  it('readScopeFile 拒绝路径穿越', () => {
    expect(() => service.readScopeFile(scopeId, '../MEMORY.md')).toThrow()
  })

  it('stats 汇总文件数与磁盘占用', () => {
    service.upsertMarkdown(scopeId, 'MEMORY.md', 'a'.repeat(100))
    service.upsertMarkdown(scopeId, 'notes/extra.md', 'b'.repeat(50))

    const s = service.stats(scopeId)
    expect(s.scopeId).toBe(scopeId)
    expect(s.fileCount).toBe(2)
    expect(s.diskBytes).toBe(150)
    expect(s.indexCount).toBe(0) // 无 db
    expect(s.scopeDir).toBe(getProjectMemoryDir(memoryRoot, scopeId))
  })
})
