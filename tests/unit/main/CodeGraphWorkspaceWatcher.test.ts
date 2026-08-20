import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CodeGraphWorkspaceWatcher,
  type ChokidarWatchFactory
} from '../../../src/main/services/CodeGraphWorkspaceWatcher'

class FakeWatcher {
  readonly listeners = new Map<string, (value: string | Error) => void>()
  options: Parameters<ChokidarWatchFactory>[1] | null = null
  closeCalls = 0

  on(event: 'add' | 'change' | 'unlink', listener: (filePath: string) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'ready', listener: () => void): this
  on(
    event: 'add' | 'change' | 'unlink' | 'error' | 'ready',
    listener: ((value: string | Error) => void) | (() => void)
  ): this {
    if (event === 'ready') {
      queueMicrotask(() => Reflect.apply(listener, undefined, []))
      return this
    }
    this.listeners.set(event, (value) => {
      if (event === 'error') {
        listener(value instanceof Error ? value : new Error(String(value)))
      } else {
        listener(String(value))
      }
    })
    return this
  }

  emit(event: 'add' | 'change' | 'unlink' | 'error', filePathOrError: string | Error): void {
    this.listeners.get(event)?.(filePathOrError)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CodeGraphWorkspaceWatcher', () => {
  it('在订阅层传入排除规则，保留根 .gitignore 且禁用轮询', async () => {
    const root = createWorkspace()
    writeFileSync(join(root, '.gitignore'), 'ignored-by-project/\n')
    const fake = createFakeWatcher()
    let ignored: ((filePath: string, stats?: unknown) => boolean) | undefined
    const createWatcher: ChokidarWatchFactory = (_root, options) => {
      ignored = options.ignored
      fake.options = options
      return fake.watcher
    }

    const source = await CodeGraphWorkspaceWatcher.create(root, { createWatcher })
    await source.whenReady()

    expect(fake.options?.ignoreInitial).toBe(true)
    expect(fake.options?.followSymlinks).toBe(false)
    expect(fake.options?.usePolling).toBe(false)
    expect(fake.options?.cwd).toBe(root)
    expect(ignored?.(root)).toBe(false)
    expect(ignored?.(join(root, 'node_modules', 'package.json'))).toBe(true)
    expect(ignored?.(join(root, '.git', 'HEAD'))).toBe(true)
    expect(ignored?.(join(root, 'build', 'bundle.js'))).toBe(true)
    expect(ignored?.(join(root, '.cache', 'entry'))).toBe(true)
    expect(ignored?.(join(root, 'ignored-by-project', 'file.ts'))).toBe(true)
    expect(ignored?.(join(root, '.gitignore'))).toBe(false)
    await source.close()
  })

  it('将 chokidar 文件事件转换为规范化工作区相对路径', async () => {
    const root = createWorkspace()
    const fake = createFakeWatcher()
    const source = await CodeGraphWorkspaceWatcher.create(root, {
      createWatcher: (_root, options) => {
        fake.options = options
        return fake.watcher
      }
    })
    await source.whenReady()
    const changes: Array<{ type: string; path: string }> = []
    source.subscribe((change) => changes.push(change))

    fake.watcher.emit('add', join(root, 'src', 'feature.ts'))
    fake.watcher.emit('change', `src${'\\'}feature.ts`)
    fake.watcher.emit('unlink', join(root, 'src', '..', 'src', 'feature.ts'))
    fake.watcher.emit('change', join(root, '..', 'outside.ts'))

    expect(changes).toEqual([
      { type: 'add', path: 'src/feature.ts' },
      { type: 'change', path: 'src/feature.ts' },
      { type: 'unlink', path: 'src/feature.ts' }
    ])
    await source.close()
  })

  it('watcher error 会通知订阅者并关闭资源，重复 close 不重复关闭', async () => {
    const root = createWorkspace()
    const fake = createFakeWatcher()
    const source = await CodeGraphWorkspaceWatcher.create(root, {
      createWatcher: (_root, options) => {
        fake.options = options
        return fake.watcher
      }
    })
    await source.whenReady()
    const errors: string[] = []
    const changes: string[] = []
    source.subscribeError((error) => errors.push(error.message))
    source.subscribe((change) => changes.push(change.path))

    fake.watcher.emit('error', new Error('watch failed'))
    fake.watcher.emit('change', join(root, 'src', 'after-error.ts'))
    await source.close()
    await source.close()

    expect(errors).toEqual(['watch failed'])
    expect(changes).toEqual([])
    expect(fake.watcher.closeCalls).toBe(1)
  })

  it('根 .gitignore 变化后原订阅层 matcher 会更新', async () => {
    const root = createWorkspace()
    const fake = createFakeWatcher()
    let loadCount = 0
    const source = await CodeGraphWorkspaceWatcher.create(root, {
      createWatcher: (_root, options) => {
        fake.options = options
        return fake.watcher
      },
      loadIgnoreMatcher: async () => {
        loadCount += 1
        const ignoreGenerated = loadCount > 1
        return (relativePath) => ignoreGenerated && relativePath.startsWith('generated/')
      }
    })
    await source.whenReady()
    expect(fake.options?.ignored(join(root, 'generated', 'file.ts'))).toBe(false)

    fake.watcher.emit('change', join(root, '.gitignore'))
    await expect.poll(() => loadCount).toBe(2)

    expect(fake.options?.ignored(join(root, 'generated', 'file.ts'))).toBe(true)
    await source.close()
  })
})

function createWorkspace(): string {
  const root = join(tmpdir(), `nova-code-graph-watcher-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

function createFakeWatcher(): { readonly watcher: FakeWatcher } {
  return { watcher: new FakeWatcher() }
}
