import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from 'fs'
import * as fsp from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  snapshotWorkspace,
  snapshotMtimes,
  diffSnapshots
} from '../../../../src/runtime/checkpoints/snapshot'

vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('fs/promises')>()
}))

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
    vi.restoreAllMocks()
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

  it('includeContent:false 只记 mtime 与 size，不读正文', async () => {
    tempDir = createTempWorkspace({
      'src/main.ts': 'const x = 1',
      'README.md': '# hello'
    })

    const result = await snapshotWorkspace(tempDir, { includeContent: false })
    const main = result.get('src/main.ts')!
    expect(main.content).toBeUndefined()
    expect(main.size).toBe(11)
    expect(main.mtimeMs).toBeGreaterThan(0)
    expect(result.get('README.md')?.content).toBeUndefined()
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

  it.each([{ maxFiles: 1, maxBytes: 2 }, { maxFiles: 0, maxBytes: 0 }])(
    '预算边缘仍保持深度优先顺序和完整 mtime 覆盖 %j', async options => {
      tempDir = createTempWorkspace({
        'a.txt': '12', 'b/nested.txt': '34', 'b/sub/deep.txt': '56', 'c.txt': '78',
        '.gitignore': 'ignored/\n', 'ignored/file.txt': 'ignored', 'node_modules/x.txt': 'skip'
      })
      const before = await snapshotWorkspace(tempDir, options)
      const original = fsp.stat
      vi.spyOn(fsp, 'stat').mockImplementation(async (...args) => {
        if (String(args[0]).endsWith('a.txt')) await new Promise(resolve => setImmediate(resolve))
        return original(...args)
      })
      const after = await snapshotMtimes(tempDir, options)
      expect([...after]).toEqual([...before].map(([path, file]) => [path, file.mtimeMs]))
      expect([...after.keys()].filter(path => path !== '.gitignore'))
        .toEqual(['a.txt', 'b/nested.txt', 'b/sub/deep.txt', 'c.txt'])
    }
  )

  it.each(['ENOENT', 'EACCES'])('单文件 %s 不影响其余文件', async code => {
    tempDir = createTempWorkspace({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
    const original = fsp.stat
    vi.spyOn(fsp, 'stat').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('b.txt')) throw Object.assign(new Error(code), { code })
      return original(...args)
    })
    expect([...await snapshotMtimes(tempDir)].map(([path]) => path)).toEqual(['a.txt', 'c.txt'])
  })

  it('取消停止派发并等待所有在途 stat，返回后 Map 不再变化', async () => {
    tempDir = createTempWorkspace(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, 'x'])))
    const controller = new AbortController()
    const original = fsp.stat
    const releases: (() => void)[] = []
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    let inFlight = 0
    const stat = vi.spyOn(fsp, 'stat').mockImplementation(async (...args) => {
      inFlight++
      await new Promise<void>(resolve => {
        releases.push(resolve)
        if (releases.length === 8) ready()
      })
      try { return await original(...args) } finally { inFlight-- }
    })
    let settled = false
    const scan = snapshotMtimes(tempDir, { abortSignal: controller.signal }).then(result => {
      settled = true
      return result
    })
    await started
    controller.abort()
    expect(settled).toBe(false)
    expect(inFlight).toBe(8)
    releases.forEach(release => release())
    const result = await scan
    expect(stat).toHaveBeenCalledTimes(8)
    expect(inFlight).toBe(0)
    expect(result.size).toBe(8)
    const entries = [...result]
    await new Promise(resolve => setImmediate(resolve))
    expect([...result]).toEqual(entries)
  })

  it('真实文件变更仍识别新增、修改、删除并保留二进制原文', async () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    tempDir = createTempWorkspace({ 'a.bin': bytes, 'deleted.txt': 'old', 'same.txt': 'same' })
    const before = await snapshotWorkspace(tempDir)
    writeFileSync(join(tempDir, 'a.bin'), Buffer.from([1, 2]))
    utimesSync(join(tempDir, 'a.bin'), new Date(10000), new Date(10000))
    rmSync(join(tempDir, 'deleted.txt'))
    writeFileSync(join(tempDir, 'new.txt'), 'new')
    expect(diffSnapshots(before, await snapshotMtimes(tempDir))).toEqual({
      modified: ['a.bin'], added: ['new.txt'], deleted: ['deleted.txt']
    })
    expect(before.get('a.bin')?.content).toEqual(bytes)
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

  it('同预算下前后快照覆盖一致，未改动文件不误判删除', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) {
      files[`f${i}.txt`] = String(i)
    }
    tempDir = createTempWorkspace(files)

    const before = await snapshotWorkspace(tempDir, { maxFiles: 2 })
    const after = await snapshotMtimes(tempDir, { maxFiles: 2 })

    expect(before.size).toBe(5)
    expect(after.size).toBe(5)
    expect(diffSnapshots(before, after)).toEqual({ modified: [], added: [], deleted: [] })
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
