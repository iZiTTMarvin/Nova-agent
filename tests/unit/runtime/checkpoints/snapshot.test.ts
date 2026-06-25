import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  snapshotWorkspace,
  snapshotMtimes,
  diffSnapshots
} from '../../../../src/runtime/checkpoints/snapshot'

/** 创建临时目录并在其中生成若干文件 */
function createTempWorkspace(
  files: Record<string, string | Buffer>,
  prefix = 'nova-snapshot-'
): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
  }
  return root
}

describe('snapshot', () => {
  let tempDir: string | null = null

  afterEach(() => {
    if (tempDir && rmSync) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  // ── 基础快照功能 ─────────────────────────────────────────────

  it('snapshotWorkspace 读取工作区文件内容与 mtime', async () => {
    tempDir = createTempWorkspace({
      'src/main.ts': 'const x = 1',
      'README.md': '# hello'
    })

    const result = await snapshotWorkspace(tempDir)

    expect(result.has('src/main.ts')).toBe(true)
    expect(result.has('README.md')).toBe(true)

    const main = result.get('src/main.ts')!
    expect(main.content?.toString('utf8')).toBe('const x = 1')
    expect(main.size).toBe(11)
    expect(main.mtimeMs).toBeGreaterThan(0)
  })

  it('snapshotMtimes 只采集 mtime', async () => {
    tempDir = createTempWorkspace({
      'a.txt': 'a',
      'b.txt': 'b'
    })

    const result = await snapshotMtimes(tempDir)

    expect(result.size).toBe(2)
    expect(result.get('a.txt')).toBeGreaterThan(0)
    expect(result.get('b.txt')).toBeGreaterThan(0)
  })

  it('diffSnapshots 识别新增、修改、删除', async () => {
    const before = new Map([
      ['a.txt', { content: Buffer.from('a'), mtimeMs: 1000, size: 1 }],
      ['b.txt', { content: Buffer.from('b'), mtimeMs: 2000, size: 1 }],
      ['c.txt', { content: Buffer.from('c'), mtimeMs: 3000, size: 1 }]
    ])
    const after = new Map([
      ['a.txt', 1000],              // 未变
      ['b.txt', 2500],              // 修改
      ['d.txt', 4000]               // 新增
    ])
    // c.txt 被删除

    const diff = diffSnapshots(before, after)

    expect(diff.modified).toEqual(['b.txt'])
    expect(diff.added).toEqual(['d.txt'])
    expect(diff.deleted).toEqual(['c.txt'])
  })

  // ── 异步化：不阻塞事件循环 ───────────────────────────────────

  it('snapshotWorkspace 遍历过程中让出事件循环', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 50; i++) {
      files[`file${i}.txt`] = `content-${i}`
    }
    tempDir = createTempWorkspace(files)

    let yielded = false
    const promise = snapshotWorkspace(tempDir)
    setImmediate(() => { yielded = true })
    await promise

    expect(yielded).toBe(true)
  })

  // ── 排除清单 ────────────────────────────────────────────────

  it('跳过 node_modules / target / .git 等构建产物目录', async () => {
    tempDir = createTempWorkspace({
      'src/main.ts': 'main',
      'node_modules/pkg/index.js': 'module',
      'target/classes/Main.class': 'class',
      '.git/config': 'config',
      'dist/bundle.js': 'bundle'
    })

    const result = await snapshotWorkspace(tempDir)
    const paths = Array.from(result.keys())

    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('node_modules/pkg/index.js')
    expect(paths).not.toContain('target/classes/Main.class')
    expect(paths).not.toContain('.git/config')
    expect(paths).not.toContain('dist/bundle.js')
  })

  it('尊重 .gitignore', async () => {
    tempDir = createTempWorkspace({
      '.gitignore': 'dist\n',
      'dist/bundle.js': 'bundle',
      'src/main.ts': 'main'
    })

    const result = await snapshotWorkspace(tempDir)
    const paths = Array.from(result.keys())

    expect(paths).not.toContain('dist/bundle.js')
    expect(paths).toContain('src/main.ts')
  })

  // ── 预算保护 ───────────────────────────────────────────────

  it('maxFiles 超限时后续文件降级为 mtime-only', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) {
      files[`f${i}.txt`] = String(i)
    }
    tempDir = createTempWorkspace(files)

    const result = await snapshotWorkspace(tempDir, { maxFiles: 2 })

    expect(result.size).toBe(5)
    let contentCount = 0
    for (const entry of result.values()) {
      if (entry.content !== undefined) contentCount++
    }
    expect(contentCount).toBe(2)
  })

  it('maxBytes 超限时后续文件降级为 mtime-only', async () => {
    tempDir = createTempWorkspace({
      'a.txt': '12',
      'b.txt': '34',
      'c.txt': '56'
    })

    const result = await snapshotWorkspace(tempDir, { maxBytes: 3 })

    expect(result.size).toBe(3)
    let contentCount = 0
    for (const entry of result.values()) {
      if (entry.content !== undefined) contentCount++
    }
    // a.txt 2 字节，累计 2 ≤ 3；读 content
    // b.txt 2 字节，累计 4 > 3；降级为 mtime-only
    expect(contentCount).toBe(1)
  })

  it('超大文件（>10MB）跳过 content，只记 mtime', async () => {
    tempDir = createTempWorkspace({
      'big.bin': Buffer.alloc(11 * 1024 * 1024),
      'small.txt': 'hi'
    })

    const result = await snapshotWorkspace(tempDir)

    expect(result.get('big.bin')?.content).toBeUndefined()
    expect(result.get('big.bin')?.mtimeMs).toBeGreaterThan(0)
    expect(result.get('small.txt')?.content?.toString()).toBe('hi')
  })

  // ── abortSignal ─────────────────────────────────────────────

  it('abortSignal 可中断 snapshotWorkspace', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 100; i++) {
      files[`f${i}.txt`] = String(i)
    }
    tempDir = createTempWorkspace(files)

    const controller = new AbortController()
    const promise = snapshotWorkspace(tempDir, { abortSignal: controller.signal })
    controller.abort()
    const result = await promise

    // 中断后结果应不完整，但不会抛错
    expect(result.size).toBeLessThan(100)
  })

  it('abortSignal 可中断 snapshotMtimes', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 100; i++) {
      files[`f${i}.txt`] = String(i)
    }
    tempDir = createTempWorkspace(files)

    const controller = new AbortController()
    const promise = snapshotMtimes(tempDir, { abortSignal: controller.signal })
    controller.abort()
    const result = await promise

    expect(result.size).toBeLessThan(100)
  })
})
