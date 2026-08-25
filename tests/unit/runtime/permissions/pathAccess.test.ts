/**
 * 路径边界：canonical path、symlink / junction、SessionPathGrant。
 * 防工作区外访问被词法路径或链接绕过。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  canonicalizeTargetPath,
  clearSessionPathGrants,
  getSessionPathGrants,
  isPathAccessible,
  isPathWithinRoot,
  matchPathGrant,
  replaceSkillPathGrants,
  resolvePathAccess
} from '../../../../src/runtime/permissions/pathAccess'
import type { PathAccessKind, SessionPathGrant } from '../../../../src/shared/permissions/types'

function tempPair(): { workspace: string; outside: string } {
  return {
    workspace: mkdtempSync(join(tmpdir(), 'nova-path-ws-')),
    outside: mkdtempSync(join(tmpdir(), 'nova-path-out-'))
  }
}

function cleanup(dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}

function resolveAccess(
  workspace: string,
  inputPath: string,
  access: PathAccessKind,
  grants?: readonly SessionPathGrant[]
) {
  return resolvePathAccess({
    workingDir: workspace,
    inputPath,
    access,
    grants
  })
}

describe('pathAccess', () => {
  afterEach(() => {
    clearSessionPathGrants('path-grant-session')
    clearSessionPathGrants('path-skill-session')
  })

  it('工作区内普通文件视为 workspace', () => {
    const { workspace, outside } = tempPair()
    try {
      mkdirSync(join(workspace, 'src'))
      writeFileSync(join(workspace, 'src', 'a.ts'), 'in\n')
      const result = resolveAccess(workspace, 'src/a.ts', 'read')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.scope).toBe('workspace')
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('../ 越界不能当成工作区内', () => {
    const { workspace, outside } = tempPair()
    try {
      writeFileSync(join(outside, 'secret.txt'), 'out\n')
      const result = resolveAccess(workspace, join(workspace, '..', 'nope.txt'), 'read')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.scope).toBe('external')
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('新建文件走最近存在父目录的 canonicalization', () => {
    const { workspace, outside } = tempPair()
    try {
      const missing = join(workspace, 'nested', 'new.ts')
      const result = canonicalizeTargetPath(missing)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path.toLowerCase()).toContain('nested')
      }

      const access = resolveAccess(workspace, 'nested/new.ts', 'write')
      expect(access.ok).toBe(true)
      if (access.ok) expect(access.scope).toBe('workspace')
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('父目录是指向工作区外的链接时，新建文件不能落在工作区内', ({ skip }) => {
    const { workspace, outside } = tempPair()
    const linkDir = join(workspace, 'linked')
    try {
      try {
        symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        console.warn(`跳过新建文件父目录链接用例：${error instanceof Error ? error.message : String(error)}`)
        skip()
        return
      }

      const result = resolveAccess(workspace, join(linkDir, 'new.ts'), 'write')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.scope).toBe('external')
        expect(isPathWithinRoot(workspace, result.canonical)).toBe(false)
      }
    } finally {
      cleanup([workspace, outside])
    }
  })
})

describe.runIf(process.platform === 'win32')('pathAccess 跨盘符（Windows）', () => {
  it('拒绝跨盘符绝对路径', () => {
    expect(isPathWithinRoot('D:\\workspace\\proj', 'C:\\secret\\passwd.md')).toBe(false)
  })

  it('同盘符根内仍允许', () => {
    expect(
      isPathWithinRoot('D:\\workspace\\proj', 'D:\\workspace\\proj\\.nova\\rules\\a.md')
    ).toBe(true)
  })
})

describe('pathAccess 链接绕过', () => {
  it('symlink 指向工作区外时视为 external', ({ skip }) => {
    const { workspace, outside } = tempPair()
    const linkPath = join(workspace, 'alias.txt')
    try {
      writeFileSync(join(outside, 'secret.txt'), 'out\n')
      try {
        symlinkSync(join(outside, 'secret.txt'), linkPath)
      } catch (error) {
        console.warn(`跳过 symlink 用例：${error instanceof Error ? error.message : String(error)}`)
        skip()
        return
      }

      const result = resolveAccess(workspace, linkPath, 'read')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.scope).toBe('external')
        expect(isPathWithinRoot(workspace, result.canonical)).toBe(false)
      }
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('junction 指向工作区外时视为 external', ({ skip }) => {
    const { workspace, outside } = tempPair()
    const linkDir = join(workspace, 'linked')
    try {
      writeFileSync(join(outside, 'secret.txt'), 'out\n')
      try {
        symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        console.warn(`跳过 junction 用例：${error instanceof Error ? error.message : String(error)}`)
        skip()
        return
      }

      const result = resolveAccess(workspace, join(linkDir, 'secret.txt'), 'read')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.scope).toBe('external')
        expect(isPathWithinRoot(workspace, result.canonical)).toBe(false)
      }
      expect(
        isPathAccessible({
          workingDir: workspace,
          inputPath: join(linkDir, 'secret.txt'),
          access: 'read'
        })
      ).toBe(false)
    } finally {
      cleanup([workspace, outside])
    }
  })
})

describe('SessionPathGrant', () => {
  afterEach(() => {
    clearSessionPathGrants('path-grant-session')
    clearSessionPathGrants('path-skill-session')
  })

  it('exact 只放行该路径，subtree 放行目录内', () => {
    const { workspace, outside } = tempPair()
    try {
      writeFileSync(join(outside, 'a.txt'), 'a\n')
      writeFileSync(join(outside, 'b.txt'), 'b\n')
      const fileA = canonicalizeTargetPath(join(outside, 'a.txt'))
      const fileB = canonicalizeTargetPath(join(outside, 'b.txt'))
      const dirCanon = canonicalizeTargetPath(outside)
      expect(fileA.ok && fileB.ok && dirCanon.ok).toBe(true)
      if (!fileA.ok || !fileB.ok || !dirCanon.ok) return

      const exact: SessionPathGrant = {
        canonicalRoot: fileA.path,
        access: 'read',
        match: 'exact',
        origin: 'user'
      }
      expect(matchPathGrant([exact], fileA.path, 'read')).toBeDefined()
      expect(matchPathGrant([exact], fileB.path, 'read')).toBeUndefined()

      const subtree: SessionPathGrant = {
        canonicalRoot: dirCanon.path,
        access: 'read',
        match: 'subtree',
        origin: 'user'
      }
      expect(matchPathGrant([subtree], fileA.path, 'read')).toBeDefined()
      expect(matchPathGrant([subtree], fileB.path, 'read')).toBeDefined()

      const granted = resolveAccess(workspace, join(outside, 'a.txt'), 'read', [subtree])
      expect(granted.ok && granted.scope === 'granted').toBe(true)
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('read grant 不允许 write', () => {
    const { workspace, outside } = tempPair()
    try {
      writeFileSync(join(outside, 'a.txt'), 'a\n')
      const target = canonicalizeTargetPath(join(outside, 'a.txt'))
      expect(target.ok).toBe(true)
      if (!target.ok) return

      const grant: SessionPathGrant = {
        canonicalRoot: target.path,
        access: 'read',
        match: 'exact',
        origin: 'user'
      }
      expect(matchPathGrant([grant], target.path, 'read')).toBeDefined()
      expect(matchPathGrant([grant], target.path, 'write')).toBeUndefined()

      const writeAccess = resolveAccess(workspace, join(outside, 'a.txt'), 'write', [grant])
      expect(writeAccess.ok).toBe(true)
      if (writeAccess.ok) expect(writeAccess.scope).toBe('external')
    } finally {
      cleanup([workspace, outside])
    }
  })

  it('origin: skill 的预置 grant 让 skill 目录可读', () => {
    const { workspace, outside } = tempPair()
    const sessionId = 'path-skill-session'
    try {
      mkdirSync(join(outside, 'references'))
      writeFileSync(join(outside, 'references', 'rule.md'), 'skill\n')
      replaceSkillPathGrants(sessionId, [outside])
      const grants = getSessionPathGrants(sessionId)
      expect(grants.some(grant => grant.origin === 'skill')).toBe(true)

      const result = resolveAccess(workspace, join(outside, 'references', 'rule.md'), 'read', grants)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.scope).toBe('granted')
        expect(result.grant?.origin).toBe('skill')
      }

      const writeResult = resolveAccess(
        workspace,
        join(outside, 'references', 'rule.md'),
        'write',
        grants
      )
      expect(writeResult.ok).toBe(true)
      if (writeResult.ok) expect(writeResult.scope).toBe('external')
    } finally {
      cleanup([workspace, outside])
    }
  })
})
