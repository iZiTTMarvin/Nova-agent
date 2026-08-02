/**
 * Chromium 磁盘缓存启动重置。
 *
 * 并行或僵尸实例争用同一 userData 的缓存目录时，Chromium 缓存后端会损坏
 * （block_files / backend_impl Critical error）；dev 模式页面经 HTTP 缓存加载，
 * 缓存损坏后渲染白屏。Chromium 的自恢复需要移动旧缓存目录，目录被占用时恢复同样失败。
 *
 * 因此在 Chromium 初始化缓存之前（持单实例锁后、app ready 前）物理删除缓存目录，
 * 让每次启动必然拿到全新缓存。删除失败不阻断启动：下个启动周期仍会重试。
 */
import { rmSync } from 'fs'
import { join } from 'path'

/** Chromium 在 userData 下的磁盘缓存目录（HTTP 缓存、JS 字节码缓存、GPU/Dawn shader 缓存） */
const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache'
] as const

export function resetChromiumDiskCaches(
  userDataPath: string,
  log: (msg: string) => void = console.warn
): void {
  for (const dir of CHROMIUM_CACHE_DIRS) {
    try {
      rmSync(join(userDataPath, dir), { recursive: true, force: true })
    } catch (err) {
      log(`[cache-reset] 清理 ${dir} 失败（不阻断启动）: ${String(err)}`)
    }
  }
}
