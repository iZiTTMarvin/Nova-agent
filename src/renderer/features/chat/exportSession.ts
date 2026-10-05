/**
 * 会话导出为 Markdown：触发主进程读取激活路径，支持复制到剪贴板或保存为 .md 文件
 */
export async function exportSession(
  sessionId: string,
  target: 'clipboard' | 'file'
): Promise<void> {
  if (!sessionId) {
    window.alert('当前没有可导出的会话')
    return
  }

  try {
    const result = await window.api.invoke('session:export-markdown', { sessionId, target })
    if (result.status === 'copied') {
      window.alert('已复制全部对话')
    } else if (result.status === 'saved') {
      window.alert(`已导出到 ${result.filePath}`)
    } else if (result.status === 'failed') {
      window.alert(`导出失败：${result.error}`)
    }
  } catch (err) {
    window.alert(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
