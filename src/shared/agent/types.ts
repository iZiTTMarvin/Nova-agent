/** Hook 系统 9 个固定事件（供 renderer / 扩展监听） */
export type HookEvent =
  | 'onMessageStart'
  | 'beforeAgentStart'
  | 'preChat'
  | 'context'
  | 'preToolUse'
  | 'postToolUse'
  | 'postMessage'
  | 'onError'
  | 'onCancel'
