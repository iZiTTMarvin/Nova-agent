import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSkillRootsWatcher } from '../../../src/main/services/SkillRootsWatcher'

function fakeWatch() {
  const handlers: Array<() => void> = []
  const close = vi.fn()
  const watch = vi.fn(() => {
    const api = {
      on: (event: string, handler: () => void) => {
        if (event === 'all') handlers.push(handler)
        return api
      },
      close
    }
    return api as never
  })
  return { watch, close, fire: () => handlers.at(-1)?.() }
}

describe('SkillRootsWatcher', () => {
  let root: string

  beforeEach(() => {
    vi.useFakeTimers()
    root = join(tmpdir(), `nova-watch-${Date.now()}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('连续的文件变化只触发一次防抖回调', () => {
    const { watch, fire } = fakeWatch()
    const onChange = vi.fn()
    const watcher = createSkillRootsWatcher(onChange, watch, 400)
    watcher.setRoots([root])
    fire()
    fire()
    vi.advanceTimersByTime(399)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('监听集合不变时不重建；变化时关闭旧监听；只监听存在的目录', () => {
    const { watch, close } = fakeWatch()
    const watcher = createSkillRootsWatcher(vi.fn(), watch, 400)
    watcher.setRoots([root, join(root, 'missing')])
    watcher.setRoots([join(root, 'missing'), root])
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch.mock.calls[0]?.[0]).toEqual([root])

    watcher.setRoots([])
    expect(close).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('关闭后不再触发尚未到期的回调', () => {
    const { watch, fire } = fakeWatch()
    const onChange = vi.fn()
    const watcher = createSkillRootsWatcher(onChange, watch, 400)
    watcher.setRoots([root])
    fire()
    watcher.close()
    vi.advanceTimersByTime(1000)
    expect(onChange).not.toHaveBeenCalled()
  })
})
