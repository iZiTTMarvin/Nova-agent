import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  CODE_INDEX_MAX_SOURCE_BYTES,
  FileDiscoveryCancelledError,
  discoverCodeFiles
} from '@runtime/code-graph/indexing/FileDiscovery'

describe('code graph file discovery', () => {
  const cleanup: string[] = []

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function tempDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix))
    cleanup.push(directory)
    return directory
  }

  it('Git 集合包含 tracked/untracked 源码并尊重 ignore 与共享硬排除', async () => {
    const root = tempDirectory('nova-code-discovery-git-')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n', 'utf8')
    writeFileSync(join(root, 'src', 'tracked.ts'), 'export const value = 1\n', 'utf8')
    writeFileSync(join(root, 'src', 'untracked.py'), 'value = 1\n', 'utf8')
    writeFileSync(join(root, 'src', 'other.go'), 'package main\n', 'utf8')
    writeFileSync(join(root, 'ignored.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(root, 'dist', 'generated.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(root, 'tsconfig.json'), '{}\n', 'utf8')
    execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true })
    execFileSync('git', ['add', 'src/tracked.ts'], { cwd: root, windowsHide: true })

    const result = await discoverCodeFiles({ workspaceRoot: root })

    expect(result.source).toBe('git')
    expect(result.files.map((file) => [file.path, file.language, file.status])).toEqual([
      ['src/other.go', 'unsupported', 'unsupported'],
      ['src/tracked.ts', 'typescript', 'eligible'],
      ['src/untracked.py', 'python', 'eligible']
    ])
    expect(result.configFiles).toEqual(['tsconfig.json'])
    expect(result.files.some((file) => file.path.includes('dist/'))).toBe(false)
    expect(result.files.some((file) => file.path === 'ignored.ts')).toBe(false)
  })

  it('Git 不可用时走异步 fallback，并标记超大与不支持源码', async () => {
    const root = tempDirectory('nova-code-discovery-fallback-')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'hidden'), { recursive: true })
    writeFileSync(join(root, '.gitignore'), 'src/ignored.py\n', 'utf8')
    writeFileSync(join(root, 'src', 'ok.jsx'), 'export const App = () => null\n', 'utf8')
    writeFileSync(join(root, 'src', 'ignored.py'), 'value = 1\n', 'utf8')
    writeFileSync(join(root, 'src', 'other.rs'), 'fn main() {}\n', 'utf8')
    writeFileSync(join(root, 'src', 'analysis.r'), 'value <- 1\n', 'utf8')
    writeFileSync(join(root, 'src', 'notes.md'), '# not source\n', 'utf8')
    writeFileSync(
      join(root, 'src', 'large.ts'),
      Buffer.alloc(CODE_INDEX_MAX_SOURCE_BYTES + 1, 97)
    )
    writeFileSync(join(root, 'node_modules', 'hidden', 'dep.ts'), 'export {}\n', 'utf8')

    const result = await discoverCodeFiles({
      workspaceRoot: root,
      listGitFiles: async () => {
        throw new Error('git unavailable')
      }
    })

    expect(result.source).toBe('fallback')
    expect(result.diagnostics).toContainEqual({ path: null, reason: 'git_unavailable' })
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ['src/large.ts', 'skipped_too_large'],
      ['src/ok.jsx', 'eligible'],
      ['src/analysis.r', 'unsupported'],
      ['src/other.rs', 'unsupported']
    ].sort((left, right) => left[0].localeCompare(right[0], 'en')))
    expect(result.files.some((file) => file.path === 'src/notes.md')).toBe(false)
  })

  it('realpath 拒绝指向 workspace 外部的 junction 候选', async () => {
    const root = tempDirectory('nova-code-discovery-root-')
    const outside = tempDirectory('nova-code-discovery-outside-')
    writeFileSync(join(outside, 'external.ts'), 'export const secret = 1\n', 'utf8')
    symlinkSync(outside, join(root, 'linked'), 'junction')

    const result = await discoverCodeFiles({
      workspaceRoot: root,
      listGitFiles: async () => ['linked/external.ts']
    })

    expect(result.files).toEqual([])
    expect(result.diagnostics).toContainEqual({
      path: 'linked/external.ts',
      reason: 'outside_workspace'
    })
  })

  it('取消与非规范路径都在读取前被拒绝', async () => {
    const root = tempDirectory('nova-code-discovery-cancel-')
    const controller = new AbortController()
    controller.abort()

    await expect(discoverCodeFiles({
      workspaceRoot: root,
      abortSignal: controller.signal
    })).rejects.toBeInstanceOf(FileDiscoveryCancelledError)

    const result = await discoverCodeFiles({
      workspaceRoot: root,
      listGitFiles: async () => ['../outside.ts', './inside.ts', 'src//double.ts']
    })
    expect(result.files).toEqual([])
    expect(result.diagnostics.map((item) => item.reason)).toEqual([
      'invalid_path', 'invalid_path', 'invalid_path'
    ])
  })
})
