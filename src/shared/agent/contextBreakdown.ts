/** 会话上下文容量拆分（IPC agent:context-breakdown 载荷） */
export interface ContextBreakdown {
  sessionId: string
  messageId: string
  breakdown: {
    systemPrompt: number
    skills: number
    tools: number
    messages: number
    other: number
  }
  totalEstimated: number
  promptTokensActual: number
  capturedAt: number
  contextLimit?: number
}
