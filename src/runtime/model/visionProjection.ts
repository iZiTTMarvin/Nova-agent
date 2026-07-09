/**
 * 发 API 前的视觉能力投影。
 *
 * 原则：
 * - 不改写 SessionStore / UI blocks（磁盘保留 nova-image 资产，换模型可恢复）
 * - 只改即将发给模型的 ChatMessage[]
 * - 非视觉模型：剥离所有 image_url，避免 400 污染整段会话
 * - MiMo 等 provider：tool 消息 content 必须是 string，把工具图提升为后续 user 多模态消息
 */
import { extractTextFromContent, type ChatMessage, type ContentBlock } from './types'

const IMAGE_OMITTED_USER =
  '[系统提示] 当前模型不支持图片输入，历史消息中的图片已省略，未发送给模型。'
const IMAGE_OMITTED_TOOL =
  '[系统提示] 当前模型不支持图片输入，工具返回的图片已省略。'

export interface VisionProjectionOptions {
  supportsVision: boolean
  modelId: string
  baseUrl: string
}

/** 是否为 Xiaomi MiMo 类：tool.content 不接受 ContentPart[] */
export function providerRejectsToolMultimodal(modelId: string, baseUrl: string): boolean {
  const id = modelId.toLowerCase()
  const url = baseUrl.toLowerCase()
  return id.includes('mimo') || url.includes('mimo') || url.includes('xiaomimimo')
}

function isImageBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'image_url' }> {
  return block.type === 'image_url'
}

function hasImageBlocks(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false
  return content.some(isImageBlock)
}

/** 从多模态 content 抽出纯文本；无文本时用 fallback */
function textFromContent(content: string | ContentBlock[], fallback: string): string {
  if (typeof content === 'string') {
    const t = content.trim()
    return t || fallback
  }
  const text = extractTextFromContent(content).trim()
  return text || fallback
}

/** 非视觉：把 content 压成不含 image_url 的合法形态 */
function stripImagesFromContent(
  content: string | ContentBlock[],
  omittedNote: string
): string {
  if (typeof content === 'string') return content || omittedNote
  if (!hasImageBlocks(content)) {
    const text = extractTextFromContent(content).trim()
    return text || omittedNote
  }
  const text = extractTextFromContent(content).trim()
  if (!text) return omittedNote
  return `${text}\n\n${omittedNote}`
}

/**
 * 按当前模型能力投影消息列表（纯函数，不修改入参）。
 */
export function projectMessagesForVision(
  messages: ChatMessage[],
  opts: VisionProjectionOptions
): ChatMessage[] {
  if (!opts.supportsVision) {
    return messages.map(msg => {
      if (!hasImageBlocks(msg.content)) return msg
      const note = msg.role === 'tool' ? IMAGE_OMITTED_TOOL : IMAGE_OMITTED_USER
      return {
        ...msg,
        content: stripImagesFromContent(msg.content, note)
      }
    })
  }

  // 视觉模型且 provider 接受 tool 多模态 → 原样
  if (!providerRejectsToolMultimodal(opts.modelId, opts.baseUrl)) {
    return messages
  }

  // MiMo 等：tool 含图时压成 string，图片提升为紧随其后的 user 多模态消息
  const out: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role !== 'tool' || !hasImageBlocks(msg.content)) {
      out.push(msg)
      continue
    }

    const blocks = msg.content as ContentBlock[]
    const imageBlocks = blocks.filter(isImageBlock)
    const text = textFromContent(blocks, '（工具返回了图片）')

    out.push({
      ...msg,
      content: `${text}\n\n[系统提示] 工具返回的图片已附在下一条用户消息中（当前 API 要求 tool.content 为纯文本）。`
    })
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: '[来自上一轮工具结果的图片]' },
        ...imageBlocks
      ],
      // 不参与 cache 断点，避免把动态插入的图钉在前缀上
      skipCacheMarker: true
    })
  }
  return out
}
