/**
 * web_fetch 的 URL 内容缓存：内容寻址文件缓存（~/.nova/cache/web-fetch/）。
 *
 * 目标：agent 反复读同一文档站是最大的 token 成本（天枢验证），
 * TTL 2 天内重读同一 URL 零抓取。只缓存成功且实质内容；磁盘总量上限 + LRU 淘汰。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

const CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000
/** 缓存磁盘总量上限；超出后按 mtime 从旧到新淘汰 */
const CACHE_MAX_BYTES = 50 * 1024 * 1024
/** 单条缓存（正文 + 元数据）的体积上限；超大的页面不缓存（重抓比占盘便宜） */
const CACHE_ENTRY_MAX_BYTES = 1024 * 1024

export interface CachedFetch {
  finalUrl: string
  content: string
  contentType?: string
  fetchedAt: number
}

interface CacheEntry extends CachedFetch {
  bodySha256: string
}

function cacheDir(): string {
  // 环境覆盖点：测试与沙箱隔离用，生产无此变量
  if (process.env.NOVA_WEB_FETCH_CACHE_DIR) return process.env.NOVA_WEB_FETCH_CACHE_DIR
  return join(homedir(), '.nova', 'cache', 'web-fetch')
}

/** 缓存 key：规范化 URL 的 sha256（小写 host、去默认端口在 normalize 时已做） */
function cacheKey(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex')
}

function entryPath(key: string): string {
  return join(cacheDir(), `${key}.json`)
}

export function cacheGet(normalizedUrl: string): CachedFetch | null {
  const path = entryPath(cacheKey(normalizedUrl))
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const entry = JSON.parse(raw) as CacheEntry
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
      rmSync(path, { force: true })
      return null
    }
    const bodySha = createHash('sha256').update(entry.content, 'utf8').digest('hex')
    if (bodySha !== entry.bodySha256) {
      // 缓存损坏：丢弃重抓（宁重勿错）
      rmSync(path, { force: true })
      return null
    }
    return { finalUrl: entry.finalUrl, content: entry.content, contentType: entry.contentType, fetchedAt: entry.fetchedAt }
  } catch {
    return null
  }
}

export function cachePut(normalizedUrl: string, value: CachedFetch): void {
  const contentBytes = Buffer.byteLength(value.content, 'utf8')
  if (contentBytes > CACHE_ENTRY_MAX_BYTES) return
  try {
    mkdirSync(cacheDir(), { recursive: true })
    evictIfNeeded(contentBytes)
    const entry: CacheEntry = {
      ...value,
      bodySha256: createHash('sha256').update(value.content, 'utf8').digest('hex')
    }
    writeFileSync(entryPath(cacheKey(normalizedUrl)), JSON.stringify(entry), 'utf8')
  } catch {
    // 缓存写入失败不影响抓取主路径
  }
}

function evictIfNeeded(incomingBytes: number): void {
  if (!existsSync(cacheDir())) return
  const files = readdirSync(cacheDir()).filter(name => name.endsWith('.json'))
  const sized = files
    .map(name => {
      const full = join(cacheDir(), name)
      try {
        return { full, size: statSync(full).size, mtime: statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { full: string; size: number; mtime: number } => item !== null)
    .sort((a, b) => a.mtime - b.mtime)
  let total = sized.reduce((sum, item) => sum + item.size, 0) + incomingBytes
  for (const item of sized) {
    if (total <= CACHE_MAX_BYTES) break
    try {
      rmSync(item.full, { force: true })
      total -= item.size
    } catch {
      // 单条删除失败继续下一条
    }
  }
}
