/** MiniMax 等模型会在 XML 调用外层插入的占位符 token（含 <minimax:tool_call> 命名空间变体） */
const MINIMAX_ARTIFACTS = /\]?<\/?minimax(?::[a-zA-Z_]+)?>\[?/g

/** 清理文本中的 MiniMax 占位符，避免它们破坏 XML 解析。 */
export function stripMinimaxArtifacts(text: string): string {
  return text.replace(MINIMAX_ARTIFACTS, '')
}
