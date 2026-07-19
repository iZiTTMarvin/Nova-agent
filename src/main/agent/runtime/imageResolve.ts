/**
 * 把 nova-image:// URL 临时读回 base64 data URL，仅供发给模型 API（模型不认识自定义协议）。
 * 不持久化——持久化始终只存 nova-image:// URL。
 *
 * 读盘失败时回退为最小占位 data URL（1x1 png），避免整条消息因单张图读盘失败而中断。
 * 同步读盘：图片通常 <5MB，读盘 <10ms，远小于一次模型 API 调用。
 */
import * as fs from 'fs'
import type { ImageStore } from '../../../runtime/storage/ImageStore'

/** 1x1 透明 PNG，作为图片读盘异常时的占位兜底 */
export const PLACEHOLDER_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export function resolveToDataUrl(
  imageStore: ImageStore,
  url: string,
  fallbackMime?: string
): string {
  const resolved = imageStore.resolveUrl(url)
  if (!resolved) {
    console.error(`[imageResolve] 图片 URL 解析失败，回退占位: ${url}`)
    return PLACEHOLDER_PNG_DATA_URL
  }
  try {
    const buffer = fs.readFileSync(resolved.filePath)
    // octet-stream 表示扩展名未能推导 MIME，用渲染层传入的 mimeType 兜底
    const mime =
      resolved.mimeType === 'application/octet-stream' && fallbackMime
        ? fallbackMime
        : resolved.mimeType
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch (err) {
    console.error(`[imageResolve] 图片读盘失败，回退占位: ${resolved.filePath}`, err)
    return PLACEHOLDER_PNG_DATA_URL
  }
}
