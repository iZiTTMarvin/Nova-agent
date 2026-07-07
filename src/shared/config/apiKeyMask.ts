/** API Key IPC 掩码工具（无 Electron 依赖，runtime/renderer 均可使用） */

/** 掩码格式：前 3 + *** + 后 3，如 sk-***abc */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 6) return '***'
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`
}

/** 判断是否为掩码占位（用户未修改 key） */
export function isMaskedApiKey(value: string): boolean {
  return value.includes('***')
}
