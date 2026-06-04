/**
 * 图片附件工具函数
 * 提供图片校验、编码、类型定义，供 ChatPanel 上传交互使用。
 * 采用纯前端 FileReader.readAsDataURL 编码，不经过主进程落盘。
 */

export interface ImageAttachment {
  /** UUID，用于列表管理 */
  id: string
  fileName: string
  /** base64 data: URI，可直接作为 <img src> */
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
 * 将 File 对象编码为 ImageAttachment
 * @returns 编码成功返回 { attachment }，失败返回 { error }
 */
export async function fileToImageAttachment(file: File): Promise<
  { attachment: ImageAttachment } | { error: string }
> {
  const validation = validateImageFile(file)
  if (!validation.valid) {
    return { error: validation.reason || '图片校验失败' }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      resolve({
        attachment: {
          id: crypto.randomUUID(),
          fileName: file.name,
          dataUrl,
          mimeType: file.type,
          size: file.size
        }
      })
    }
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
