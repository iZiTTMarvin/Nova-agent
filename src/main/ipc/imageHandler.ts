/**
 * 图片落盘 IPC handler
 *
 * 渲染层用户上传图片后，base64 data URL 经 IPC 传到主进程，
 * ImageStore 落盘后返回 nova-image:// URL，渲染层此后只持有 URL（不再有 base64）。
 */
import { handle } from './secureIpc'
import { IMAGE_SAVE } from '../../shared/ipc/channels'
import type { ImageStore } from '../../runtime/storage/ImageStore'
import { prepareImageForStorage } from '../images/imageIngest'

/**
 * 注册图片保存 IPC handler。
 * @param getImageStore 返回 ImageStore 实例的 getter（延迟取值，避免初始化顺序耦合）
 */
export function registerImageHandler(getImageStore: () => ImageStore): void {
  handle(IMAGE_SAVE, async (_event, params: {
    sessionId: string
    fileName: string
    dataUrl: string
    mimeType: string
  }): Promise<{ url: string }> => {
    const store = getImageStore()
    let prepared
    try {
      prepared = await prepareImageForStorage(params.dataUrl, params.mimeType)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请重试'
      throw new Error(`图片“${params.fileName}”处理失败：${detail}`)
    }
    const { url } = store.save(params.sessionId, prepared.dataUrl, prepared.mimeType)
    return { url }
  })
}
