import React, { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * openui 块的交互作用域：所属会话 + 文本块位置 `${sessionId}:${messageId}:${blockIndex}`。
 * 只有助手正文文本块提供它；思考块、用户消息等读不到作用域的入口一律按代码块渲染。
 */
export interface InlineUiScopeValue {
  readonly sessionId: string
  readonly blockKey: string
}

export const InlineUiScope = createContext<InlineUiScopeValue | null>(null)

export function useInlineUiScope(): InlineUiScopeValue | null {
  return useContext(InlineUiScope)
}

/** 只有声明为宿主的表面（学习对话）挂作用域；开发对话没有界面状态回传，围栏按普通代码块显示 */
const InlineUiHost = createContext(false)

export const InlineUiHostProvider = InlineUiHost.Provider

export function useInlineUiHost(): boolean {
  return useContext(InlineUiHost)
}

/** 值对象按三元组记忆，流式重渲染时不让消费方跟着失效 */
export function InlineUiScopeProvider({ sessionId, messageId, blockIndex, children }: {
  sessionId: string
  messageId: string
  blockIndex: number
  children: ReactNode
}): React.ReactElement {
  const value = useMemo(
    () => ({ sessionId, blockKey: `${sessionId}:${messageId}:${blockIndex}` }),
    [sessionId, messageId, blockIndex]
  )
  return <InlineUiScope.Provider value={value}>{children}</InlineUiScope.Provider>
}
