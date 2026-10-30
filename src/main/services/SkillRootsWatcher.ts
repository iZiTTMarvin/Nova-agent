/**
 * 技能目录监听：目录内增删改后防抖通知上层重新扫描，让第三方技能的增删即时可见。
 * 只监听已存在的目录；监听集合随每次扫描结果整体对齐，集合不变时不重建 watcher。
 */
import { existsSync } from 'fs'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'

type WatchFn = (paths: string[], options: Parameters<typeof chokidarWatch>[1]) => Pick<FSWatcher, 'on' | 'close'>

export interface SkillRootsWatcher {
  setRoots(roots: readonly string[]): void
  close(): void
}

const DEBOUNCE_MS = 400
// 技能目录结构是 <root>/<skill>/SKILL.md，两层足够发现增删与 SKILL.md 变化
const WATCH_DEPTH = 2
const IGNORED = /(^|[/\\])(node_modules|\.git|\.archive)([/\\]|$)/

export function createSkillRootsWatcher(
  onChange: () => void,
  watchFn: WatchFn = chokidarWatch,
  debounceMs: number = DEBOUNCE_MS
): SkillRootsWatcher {
  let current: FSWatcher | Pick<FSWatcher, 'on' | 'close'> | null = null
  let currentKey = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  const closeCurrent = (): void => {
    void current?.close()
    current = null
    currentKey = ''
  }

  return {
    setRoots(roots) {
      const existing = [...new Set(roots)].filter(root => existsSync(root)).sort()
      const key = existing.join('\n')
      if (key === currentKey) return
      closeCurrent()
      if (existing.length === 0) return
      currentKey = key
      current = watchFn(existing, {
        ignoreInitial: true,
        depth: WATCH_DEPTH,
        followSymlinks: true,
        ignorePermissionErrors: true,
        ignored: IGNORED
      })
      current.on('all', schedule).on('error', () => undefined)
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = null
      closeCurrent()
    }
  }
}
