/**
 * 会话消息在 renderer 侧的显示分页常量。
 * 主进程 LOAD_SESSION / load-session-messages 与 useChatStore 共用，避免首屏条数不一致。
 */

/** 进入会话时首屏展示的尾部消息条数 */
export const INITIAL_SESSION_DISPLAY_PAGE_SIZE = 20

/** 用户上滚到顶时，每次向更早方向补载的条数 */
export const SESSION_HISTORY_PAGE_SIZE = 40
