/**
 * 学习回复末尾「下一步推荐」的契约：教学提示要求模型把推荐写进这个语言的代码块，
 * Renderer 从正文里取出并渲染成回复下方的建议条，正文不再显示该代码块。
 * 推荐会原样作为用户的下一条消息发出，所以只保留短句，丢弃空行、编号与超长行。
 */
export const LEARNING_SUGGESTIONS_FENCE = 'suggestions'
export const LEARNING_SUGGESTIONS_MAX = 3
export const LEARNING_SUGGESTION_MAX_CHARS = 40

const FENCE_PATTERN = new RegExp('```' + LEARNING_SUGGESTIONS_FENCE + '[^\\S\\n]*\\n([\\s\\S]*?)\\n?```', 'g')
const OPEN_FENCE_PATTERN = new RegExp('\\n?```' + LEARNING_SUGGESTIONS_FENCE + '[^\\S\\n]*(\\n[\\s\\S]*)?$')
const LIST_MARKER = /^(?:[-*•]|\d+[.、)])\s*/u

/** 取最后一个完整推荐块里的条目；没有完整块时返回空数组。 */
export function parseLearningSuggestions(text: string): string[] {
  const blocks = [...text.matchAll(FENCE_PATTERN)]
  const body = blocks.at(-1)?.[1]
  if (body === undefined) return []
  const items: string[] = []
  for (const line of body.split('\n')) {
    const item = line.trim().replace(LIST_MARKER, '').trim()
    if (!item || Array.from(item).length > LEARNING_SUGGESTION_MAX_CHARS || items.includes(item)) continue
    items.push(item)
    if (items.length === LEARNING_SUGGESTIONS_MAX) break
  }
  return items
}

/** 去掉推荐块（含流式中尚未闭合的尾部块），用于复制等需要纯正文的场景。 */
export function stripLearningSuggestions(text: string): string {
  return text.replace(FENCE_PATTERN, '').replace(OPEN_FENCE_PATTERN, '').trimEnd()
}
