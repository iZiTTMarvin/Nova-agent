/**
 * IPC channel 名称常量
 * 所有 channel 统一在此定义，避免字符串硬编码
 */

// ── renderer → main（invoke 命令） ──────────────────────

export const PING = 'ping' as const
export const SELECT_PROJECT = 'select-project' as const
export const SEND_MESSAGE = 'send-message' as const
/** Skill 管理 IPC（renderer → main） */
export const SKILL_LIST = 'skill:list' as const
export const SKILL_GET = 'skill:get' as const
export const SKILL_CREATE = 'skill:create' as const
export const SKILL_DELETE = 'skill:delete' as const
export const SKILL_TOGGLE = 'skill:toggle' as const
export const SKILL_IMPORT = 'skill:import' as const
export const SKILL_EXPORT = 'skill:export' as const
export const SKILL_RELOAD = 'skill:reload' as const
export const CANCEL_EXECUTION = 'cancel-execution' as const
export const SAVE_MODEL_CONFIG = 'save-model-config' as const
export const LOAD_MODEL_CONFIG = 'load-model-config' as const
export const SET_MODE = 'set-mode' as const
export const ACCEPT_FILE = 'accept-file' as const
export const REJECT_FILE = 'reject-file' as const
export const ROLLBACK_MESSAGE = 'rollback-message' as const
export const RESPOND_PERMISSION = 'respond-permission' as const
export const RESPOND_VERIFICATION_PERMISSION = 'respond-verification-permission' as const
export const LOAD_SESSIONS = 'load-sessions' as const
export const LOAD_SESSION = 'load-session' as const
export const CREATE_SESSION = 'create-session' as const
export const DELETE_SESSION = 'delete-session' as const
export const GET_MESSAGE_DIFFS = 'get-message-diffs' as const
export const WINDOW_MINIMIZE = 'window-minimize' as const
export const WINDOW_MAXIMIZE = 'window-maximize' as const
export const WINDOW_CLOSE = 'window-close' as const
export const WINDOW_IS_MAXIMIZED = 'window-is-maximized' as const


// ── main → renderer（事件推送） ──────────────────────

export const AGENT_MESSAGE_START = 'agent:message-start' as const
export const AGENT_TEXT_DELTA = 'agent:text-delta' as const
export const AGENT_TOOL_CALL_START = 'agent:tool-call-start' as const
export const AGENT_TOOL_CALL_DELTA = 'agent:tool-call-delta' as const
export const AGENT_TOOL_CALL = 'agent:tool-call' as const
export const AGENT_TOOL_RESULT = 'agent:tool-result' as const
export const AGENT_PERMISSION_REQUEST = 'agent:permission-request' as const
export const AGENT_VERIFICATION_PERMISSION_REQUEST = 'agent:verification-permission-request' as const
export const AGENT_VERIFICATION_PERMISSION_CLEARED = 'agent:verification-permission-cleared' as const
export const AGENT_DIFF_UPDATE = 'agent:diff-update' as const
export const AGENT_VERIFICATION_RESULT = 'agent:verification-result' as const
export const AGENT_TODOS_UPDATED = 'agent:todos-updated' as const
export const AGENT_ERROR = 'agent:error' as const
export const AGENT_MESSAGE_END = 'agent:message-end' as const
export const AGENT_THINKING_DELTA = 'agent:thinking-delta' as const
export const AGENT_USAGE = 'agent:usage' as const
export const AGENT_HOOK_ERROR = 'agent:hook-error' as const
export const AGENT_RECOVERY_HINT = 'agent:recovery-hint' as const
export const AGENT_RECOVERY_STATE = 'agent:recovery-state' as const
export const WINDOW_MAXIMIZE_CHANGE = 'window:maximize-change' as const
export const SKILL_CHANGED = 'skill:changed' as const
