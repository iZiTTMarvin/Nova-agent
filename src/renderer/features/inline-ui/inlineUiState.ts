/**
 * openui 交互状态的唯一写入方。
 *
 * key 为 `${blockKey}#${codeHash}`：blockKey 区分会话、消息与文本块位置，代码哈希
 * 区分同一文本块里的多个组件；同一块重挂（封口、折叠重排、虚拟列表滚动）时 key 不变，
 * 状态自然恢复。按最近使用淘汰，上限 200 条；镜像到 localStorage，重启后仍在。
 */
import type { InlineUiPrimitive } from './inlineUiLanguage'

const MAX_ENTRIES = 200
const STORAGE_KEY = 'nova.inline-ui.state.v1'
const PERSIST_DELAY_MS = 300

type StoredVars = Record<string, InlineUiPrimitive>

let store: Map<string, StoredVars> | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleFlushBound = false

/** FNV-1a 32 位 + 长度：只用于区分同一文本块内的不同组件代码，不做安全用途 */
function hashCode(code: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${code.length.toString(36)}${(hash >>> 0).toString(36)}`
}

export function inlineUiStateKey(blockKey: string, code: string): string {
  return `${blockKey}#${hashCode(code)}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function sanitizeVars(raw: unknown): StoredVars | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: StoredVars = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') out[name] = value
  }
  return out
}

function load(): Map<string, StoredVars> {
  if (store) return store
  store = new Map()
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) return store
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return store
    for (const entry of parsed.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const vars = sanitizeVars(entry[1])
      if (vars) store.set(entry[0], vars)
    }
  } catch {
    // 损坏的持久化数据整体丢弃，只影响组件恢复初始值
  }
  return store
}

function persistNow(): void {
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...load()]))
  } catch {
    // 配额不足时只保留内存态
  }
}

function flushPendingPersist(): void {
  if (persistTimer !== null) persistNow()
}

/** 刷新、关闭或切到后台时合并窗口还没到期：立刻落盘，最后一次操作不丢 */
function bindLifecycleFlush(): void {
  if (lifecycleFlushBound || typeof window === 'undefined') return
  lifecycleFlushBound = true
  window.addEventListener('pagehide', flushPendingPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingPersist()
  })
}

/** 拖动滑块会连续写入，落盘合并到最后一次 */
function schedulePersist(): void {
  if (!storage() || persistTimer !== null) return
  bindLifecycleFlush()
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS)
}

export function readInlineUiState(key: string): StoredVars | undefined {
  const map = load()
  const value = map.get(key)
  if (value !== undefined) {
    // 读取也算使用：重新插入末尾，避免活跃块被误淘汰
    map.delete(key)
    map.set(key, value)
  }
  return value
}

export function writeInlineUiState(key: string, vars: StoredVars): void {
  const map = load()
  if (map.has(key)) map.delete(key)
  map.set(key, vars)
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  schedulePersist()
}

export function clearInlineUiState(key: string): void {
  if (load().delete(key)) schedulePersist()
}
