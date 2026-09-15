/**
 * @ 文件引用协议：从消息文本提取引用并生成模型侧提示行。
 *
 * 芯片在 composer 序列化为纯文本 `@相对路径`；发送链在模型侧任务前
 * 注入提示行（用户消息落盘保持纯净），保证模型可靠解析、不靠猜。
 */

/**
 * 提取 @ 引用。边界是空白与 @ 及常见中英文标点（中文标点不属于 \s，
 * 必须显式排除）；捕获后再要求路径特征（含 / . _），避开 @所有人 式提及
 * 与邮箱（@ 前是字母，不满足行首/空白边界）。
 */
const FILE_REF_PATTERN = /(?:^|\s)@([^\s@，。；！？、：""''（）【】《》…—[\]{}()<>,;:!"']+)/g

export function extractFileReferences(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = FILE_REF_PATTERN.exec(text)) !== null) {
    const path = match[1]
    if (!/[/._]/.test(path)) continue
    if (!seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }
  return out
}

/** 模型侧提示行：告知引用列表与读取方式 */
export function buildFileReferencePrefix(paths: string[]): string {
  return `[用户引用了文件：${paths.join('、')}。需要内容时用 read 工具读取对应路径。]\n`
}
