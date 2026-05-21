/**
 * IPC channel 名称常量
 * 所有 channel 统一在此定义，避免字符串硬编码
 */

// ── renderer → main（invoke 命令） ──────────────────────

export const PING = 'ping' as const
export const SELECT_PROJECT = 'select-project' as const
export const SEND_MESSAGE = 'send-message' as const
export const CANCEL_EXECUTION = 'cancel-execution' as const
export const SAVE_MODEL_CONFIG = 'save-model-config' as const
export const LOAD_MODEL_CONFIG = 'load-model-config' as const
export const SET_MODE = 'set-mode' as const
export const ACCEPT_FILE = 'accept-file' as const
export const REJECT_FILE = 'reject-file' as const
export const ROLLBACK_MESSAGE = 'rollback-message' as const
export const RESPOND_PERMISSION = 'respond-permission' as const
export const LOAD_SESSIONS = 'load-sessions' as const
export const LOAD_SESSION = 'load-session' as const
export const CREATE_SESSION = 'create-session' as const

// ── main → renderer（事件推送） ──────────────────────

export const AGENT_MESSAGE_START = 'agent:message-start' as const
export const AGENT_TEXT_DELTA = 'agent:text-delta' as const
export const AGENT_TOOL_CALL = 'agent:tool-call' as const
export const AGENT_TOOL_RESULT = 'agent:tool-result' as const
export const AGENT_PERMISSION_REQUEST = 'agent:permission-request' as const
export const AGENT_DIFF_UPDATE = 'agent:diff-update' as const
export const AGENT_VERIFICATION_RESULT = 'agent:verification-result' as const
export const AGENT_ERROR = 'agent:error' as const
export const AGENT_MESSAGE_END = 'agent:message-end' as const
