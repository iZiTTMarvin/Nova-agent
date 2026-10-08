import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs'
import { join, normalize, resolve } from 'path'
import { createHash } from 'node:crypto'
import { deriveProjectId } from '@runtime/learning/storage/workerCommand'
import { tmpdir } from 'os'
import {
  computeWorkspaceHash,
  getMemoryRoot,
  getProjectMemoryDir,
  getMemoryMdPath,
  parseScopeIdFromMemoryMdPath,
  parseScopeIdFromDirName,
  normalizeWorkspaceRoot,
  WORKSPACE_HASH_LENGTH, GLOBAL_SCOPE_ID, getGlobalMemoryDir, memoryProjectSlug,
  computeLegacyWorkspaceHashes, MemoryScopeDirectoryResolver, isManagedMemoryFile, isReservedMemoryFile,
  listProjectMemoryDirs
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
    expect(getProjectMemoryDir(memoryRoot, scopeId)).toBe(join(memoryRoot, 'projects', `project-${scopeId}`))
    expect(getMemoryMdPath(memoryRoot, scopeId)).toBe(join(memoryRoot, 'projects', `project-${scopeId}`, 'MEMORY.md'))
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

  it('parseScopeIdFromDirName 仅接受新项目目录名', () => {
    expect(parseScopeIdFromDirName('nova-' + 'a'.repeat(16))).toBe('a'.repeat(16))
    expect(parseScopeIdFromDirName('a'.repeat(16))).toBeNull()
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
    rmSync(userData, { recursive: true, force: true })
  })

  it('normalizes Windows case and trailing separators without changing the drive root', () => {
    if (process.platform === 'win32') {
      expect(computeWorkspaceHash('D:\\Project\\Nova\\')).toBe(computeWorkspaceHash('d:\\project\\nova'))
      const expected = createHash('sha256').update('d:\\').digest('hex').slice(0, 16)
      expect(computeWorkspaceHash('D:\\')).toBe(expected)
    }
    expect(computeWorkspaceHash(resolve('nova') + '/')).toBe(computeWorkspaceHash(resolve('nova')))
  })

  it('keeps the learning database identity on the original algorithm', () => {
    const workspace = 'D:\\Project\\Nova\\'
    const expected = createHash('sha256').update(normalize(resolve(workspace))).digest('hex').slice(0, 16)
    expect(deriveProjectId(workspace)).toBe(expected)
    expect(computeLegacyWorkspaceHashes(workspace)).toContain(expected)
    if (process.platform === 'win32') expect(computeLegacyWorkspaceHashes(workspace)).toHaveLength(2)
  })

  it('builds bounded slugs including empty names and a global directory', () => {
    expect(memoryProjectSlug('My App--Repo')).toBe('my-app-repo')
    expect(memoryProjectSlug('中文')).toBe('project')
    expect(memoryProjectSlug('a'.repeat(60))).toHaveLength(32)
    expect(memoryProjectSlug(resolve('/'))).toBe('project')
    expect(getProjectMemoryDir('/memory', GLOBAL_SCOPE_ID)).toBe(getGlobalMemoryDir('/memory'))
    expect(parseScopeIdFromMemoryMdPath(join('/memory', 'global', 'MEMORY.md'), '/memory')).toBe(GLOBAL_SCOPE_ID)
    expect(() => getProjectMemoryDir('/memory', '../escape')).toThrow()
  })

  it('resolves duplicate directories by current basename and invalidates moved cached directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-memory-dirs-'))
    try {
      const workspace = join(root, 'nova')
      const scopeId = computeWorkspaceHash(workspace)
      const other = join(root, 'projects', `other-${scopeId}`)
      const preferred = join(root, 'projects', `nova-${scopeId}`)
      mkdirSync(other, { recursive: true })
      mkdirSync(preferred)
      const resolver = new MemoryScopeDirectoryResolver(root)
      resolver.registerWorkspace(workspace)
      expect(resolver.resolve(scopeId)).toBe(preferred)
      expect(listProjectMemoryDirs(root, scopeId)).toHaveLength(2)
      renameSync(preferred, join(root, 'moved'))
      expect(resolver.resolve(scopeId)).toBe(other)
      resolver.clear()
      expect(resolver.resolve(scopeId)).toBe(other)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('distinguishes managed topics from ordinary documents in each scope', () => {
    expect(isReservedMemoryFile('notes.md')).toBe(true)
    expect(isManagedMemoryFile('notes.md', 'project')).toBe(false)
    expect(isManagedMemoryFile('conventions.md', 'project')).toBe(true)
    expect(isManagedMemoryFile('conventions.md', 'global')).toBe(true)
    expect(isManagedMemoryFile('facts.md', 'global')).toBe(false)
    expect(isManagedMemoryFile('preferences.md', 'global')).toBe(true)
    expect(isReservedMemoryFile('drafts/preferences.md')).toBe(false)
    expect(isManagedMemoryFile('drafts/preferences.md', 'project')).toBe(false)
  })
})
