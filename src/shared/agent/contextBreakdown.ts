/** 会话上下文容量拆分（IPC agent:context-breakdown 载荷） */
export interface ContextBreakdown {
  budget?: {
    status: 'within' | 'compact' | 'blocked'
    estimatedTokens: number
    contextWindow: number
    threshold: number
    marginTokens: number
    source: 'provider' | 'anchored-estimate' | 'conservative-estimate'
    reason: string
  }
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
