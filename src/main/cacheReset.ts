/**
 * Chromium 磁盘缓存启动重置。
 *
 * 并行或僵尸实例争用同一 userData 的缓存目录时，Chromium 缓存后端会损坏
 * （block_files / backend_impl Critical error）；dev 模式页面经 HTTP 缓存加载，
 * 缓存损坏后渲染白屏。Chromium 的自恢复需要移动旧缓存目录，目录被占用时恢复同样失败。
 *
 * 策略：
 * - dev：每次启动物理删除缓存目录，必然拿到全新缓存（重建成本约百毫秒）。
 * - 打包态：仅在上次异常退出后重建；正常退出留下的标记让下次启动跳过重建，
 *   Chromium 得以复用 HTTP 缓存与 V8 代码缓存。标记在判断后立即删除——
 *   本次会话若崩溃，下次启动无标记仍会重建，失败方向永远是"重建"。
 *   缓存损坏未必伴随主进程异常退出，渲染进程崩溃会主动作废标记（自愈出口）。
 *
 * 删除失败不阻断启动：下个启动周期仍会重试。
 */
import { existsSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Chromium 在 userData 下的磁盘缓存目录（HTTP 缓存、JS 字节码缓存、GPU/Dawn shader 缓存） */
const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache'
] as const

/** 干净退出标记（userData 根下）；存在 = 上次会话正常退出 */
export const CLEAN_SHUTDOWN_MARKER_FILE = '.chromium-cache-clean'

export interface CacheResetOptions {
  /** 打包态启用"干净退出保留缓存"策略；dev 恒为无条件重建 */
  packaged?: boolean
  log?: (msg: string) => void
}

export function resetChromiumDiskCaches(
  userDataPath: string,
  options: CacheResetOptions = {}
): void {
  const log = options.log ?? console.warn
  const marker = join(userDataPath, CLEAN_SHUTDOWN_MARKER_FILE)

  if (options.packaged && existsSync(marker)) {
    try {
      unlinkSync(marker)
      return
    } catch (err) {
      // 标记删不掉时继续走重建，避免把"已重建"误判为"无需重建"
      log(`[cache-reset] 干净退出标记删除失败，回退为重建缓存: ${String(err)}`)
    }
  }

  for (const dir of CHROMIUM_CACHE_DIRS) {
    try {
      rmSync(join(userDataPath, dir), { recursive: true, force: true })
    } catch (err) {
      log(`[cache-reset] 清理 ${dir} 失败（不阻断启动）: ${String(err)}`)
    }
  }
}

/**
 * 正常退出前调用：下次启动跳过缓存重建。写入失败仅损失缓存复用，不影响正确性。
 * 仅打包态调用——dev 永远无条件重建，不留标记，避免与打包态共享 userData 时误判。
 */
export function markChromiumCachesClean(userDataPath: string): void {
  try {
    writeFileSync(join(userDataPath, CLEAN_SHUTDOWN_MARKER_FILE), String(Date.now()), 'utf8')
  } catch (err) {
    console.warn(`[cache-reset] 干净退出标记写入失败: ${String(err)}`)
  }
}

/**
 * 渲染进程崩溃等可疑信号下调用：作废干净退出标记，下次启动强制重建缓存。
 * 缓存损坏未必伴随主进程异常退出（历史上渲染白屏时主进程仍正常收尾），
 * 这是保留缓存策略的自愈出口。
 */
export function clearChromiumCachesCleanMarker(userDataPath: string): void {
  try {
    unlinkSync(join(userDataPath, CLEAN_SHUTDOWN_MARKER_FILE))
  } catch {
    // 标记本就不存在时无需处理
  }
}
