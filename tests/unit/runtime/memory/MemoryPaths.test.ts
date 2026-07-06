import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  computeWorkspaceHash,
  getMemoryRoot,
  getProjectMemoryDir,
  getMemoryMdPath,
  parseScopeIdFromMemoryMdPath,
  parseScopeIdFromDirName,
  normalizeWorkspaceRoot,
  WORKSPACE_HASH_LENGTH
} from '../../../../src/runtime/memory/MemoryPaths'

describe('MemoryPaths', () => {
  it('workspaceHash 为 sha256(normalize).slice(0,16)', () => {
    const root = normalizeWorkspaceRoot('/tmp/nova-project')
    const hash = computeWorkspaceHash('/tmp/nova-project')
    expect(hash).toHaveLength(WORKSPACE_HASH_LENGTH)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    // 同一路径不同写法应得到相同哈希
    expect(computeWorkspaceHash(root)).toBe(hash)
  })

  it('路径构建：memoryRoot → projectDir → MEMORY.md', () => {
    const userData = '/home/user/AppData'
    const memoryRoot = getMemoryRoot(userData)
    const scopeId = 'a1b2c3d4e5f67890'
    expect(memoryRoot).toBe(join(userData, 'memory'))
    expect(getProjectMemoryDir(memoryRoot, scopeId)).toBe(join(memoryRoot, scopeId))
    expect(getMemoryMdPath(memoryRoot, scopeId)).toBe(join(memoryRoot, scopeId, 'MEMORY.md'))
  })

  it('parseScopeIdFromMemoryMdPath 可从 MEMORY.md 路径反解 scopeId', () => {
    const memoryRoot = getMemoryRoot('/data/user')
    const scopeId = computeWorkspaceHash('D:\\work\\my-app')
    const mdPath = getMemoryMdPath(memoryRoot, scopeId)
    expect(parseScopeIdFromMemoryMdPath(mdPath, memoryRoot)).toBe(scopeId)
  })

  it('parseScopeIdFromMemoryMdPath 对越界路径返回 null', () => {
    const memoryRoot = getMemoryRoot('/data/user')
    expect(parseScopeIdFromMemoryMdPath('/other/MEMORY.md', memoryRoot)).toBeNull()
    expect(parseScopeIdFromMemoryMdPath(join(memoryRoot, 'bad', 'notes.md'), memoryRoot)).toBeNull()
  })

  it('parseScopeIdFromDirName 仅接受 16 位十六进制', () => {
    expect(parseScopeIdFromDirName('a'.repeat(16))).toBe('a'.repeat(16))
    expect(parseScopeIdFromDirName('zzzz')).toBeNull()
    expect(parseScopeIdFromDirName('a'.repeat(15))).toBeNull()
  })

  it('集成：写入 MEMORY.md 后路径可往返反解', () => {
    const userData = mkdtempSync(join(tmpdir(), 'nova-mem-paths-'))
    const workspace = join(userData, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(userData)
    const scopeId = computeWorkspaceHash(workspace)
    const mdPath = getMemoryMdPath(memoryRoot, scopeId)
    mkdirSync(getProjectMemoryDir(memoryRoot, scopeId), { recursive: true })
    writeFileSync(mdPath, '# 项目记忆\n', 'utf8')
    expect(parseScopeIdFromMemoryMdPath(mdPath, memoryRoot)).toBe(scopeId)
  })
})
