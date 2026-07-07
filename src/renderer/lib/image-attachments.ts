/**
 * 图片附件工具函数
 * 提供图片校验、编码、类型定义，供 ChatPanel 上传交互使用。
 *
 * 数据流：FileReader.readAsDataURL 得到 base64 data URL（仅短暂持有用于一次 IPC 传输）→
 * IPC image:save 主进程落盘 → 返回 nova-image:// URL → ImageAttachment.dataUrl 存这个 URL。
 * renderer 堆永不持有 base64，预览与持久化都引用 nova-image:// URL。
 */

export interface ImageAttachment {
  /** UUID，用于列表管理 */
  id: string
  fileName: string
  /**
   * 图片来源 URL。
   * 落盘后为 nova-image:// URL（由主进程返回）；落盘失败时为 base64 data URL 兜底。
   * 可直接作为 <img src>。
   */
  dataUrl: string
  mimeType: string
  /** 原始文件大小（bytes），用于校验 */
  size: number
}

/** 允许上传的图片格式 */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 单张图片大小上限（20MB，与 readTool 对齐） */
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024

/** 单次上传图片数量上限 */
export const MAX_IMAGE_COUNT = 10

/**
 * 校验图片文件是否合规
 * @returns 合规返回 { valid: true }，否则返回 { valid: false, reason }
 */
export function validateImageFile(file: File): { valid: boolean; reason?: string } {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return { valid: false, reason: `不支持的图片格式: ${file.type || '未知'}` }
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return { valid: false, reason: `图片 ${file.name} 超过 20MB 限制` }
  }
  return { valid: true }
}

/**
 * 将 File 对象编码为 ImageAttachment。
 *
 * 流程：FileReader 读为 base64 data URL（仅短暂持有）→ IPC 落盘 → 拿回 nova-image:// URL。
 * 主进程落盘失败时降级为 base64 data URL 兜底（保证可用性优先）。
 *
 * @param sessionId 当前会话 ID（落盘到 sessions/{sessionId}/images/）
 */
export async function fileToImageAttachment(
  file: File,
  sessionId: string
): Promise<{ attachment: ImageAttachment } | { error: string }> {
  const validation = validateImageFile(file)
  if (!validation.valid) {
    return { error: validation.reason || '图片校验失败' }
  }

  // 1. FileReader 读 base64（仅短暂持有，落盘后即释放）
  const dataUrl = await readAsDataURL(file)

  // 2. IPC 落盘，拿回 nova-image:// URL
  try {
    const result = await window.api.invoke('image:save', {
      sessionId,
      fileName: file.name,
      dataUrl,
      mimeType: file.type
    })
    return {
      attachment: {
        id: crypto.randomUUID(),
        fileName: file.name,
        dataUrl: result.url,
        mimeType: file.type,
        size: file.size
      }
    }
  } catch (err) {
    // 主进程落盘失败：降级为 base64 data URL 兜底（可用性优先，但记日志便于排查）
    console.error('[image-attachments] 落盘失败，降级 base64:', err)
    return {
      attachment: {
        id: crypto.randomUUID(),
        fileName: file.name,
        dataUrl,
        mimeType: file.type,
        size: file.size
      }
    }
  }
}

/** 用 Promise 包装 FileReader.readAsDataURL */
function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * 从 ClipboardData 中提取图片文件列表
 */
export function getPastedImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  const files: File[] = []
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  return files
}

/**
 * 从 DataTransfer（拖拽）中提取图片文件列表
 */
export function getDroppedImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files).filter(f => f.type.startsWith('image/'))
}

/**
 * 从 DataTransfer（拖拽）中提取非图片文件列表
 */
export function getDroppedNonImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files).filter(f => !f.type.startsWith('image/'))
}
