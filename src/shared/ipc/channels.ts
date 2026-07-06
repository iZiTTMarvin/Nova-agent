/**
 * IPC channel 名称常量
 * 所有 channel 统一在此定义，避免字符串硬编码
 */

// ── renderer → main（invoke 命令） ──────────────────────

export const PING = 'ping' as const
/** 开发环境：主进程 event-loop lag 快照（仅 dev） */
export const DEV_MAIN_LOOP_LAG_SNAPSHOT = 'dev:main-loop-lag-snapshot' as const
export const DEV_MAIN_LOOP_LAG_RESET = 'dev:main-loop-lag-reset' as const
export const SELECT_PROJECT = 'select-project' as const
export const SEND_MESSAGE = 'send-message' as const
/** Skill 管理 IPC（renderer → main） */
export const SKILL_LIST = 'skill:list' as const
export const SKILL_GET = 'skill:get' as const
export const SKILL_GET_BODY = 'skill:get-body' as const
export const SKILL_CREATE = 'skill:create' as const
export const SKILL_DELETE = 'skill:delete' as const
export const SKILL_TOGGLE = 'skill:toggle' as const
export const SKILL_IMPORT = 'skill:import' as const
export const SKILL_EXPORT = 'skill:export' as const
export const SKILL_RELOAD = 'skill:reload' as const
export const SKILL_PICK_IMPORT = 'skill:pick-import' as const
/** 应用设置 */
export const SETTINGS_GET = 'settings:get' as const
export const SETTINGS_SET = 'settings:set' as const
/** Rules 管理 */
export const RULES_LIST = 'rules:list' as const
export const RULES_READ = 'rules:read' as const
export const RULES_WRITE = 'rules:write' as const
export const RULES_CREATE = 'rules:create' as const
/** Subagents 管理 */
export const SUBAGENTS_LIST = 'subagents:list' as const
export const SUBAGENTS_SAVE = 'subagents:save' as const
export const SUBAGENTS_DELETE = 'subagents:delete' as const
export const CANCEL_EXECUTION = 'cancel-execution' as const
export const SAVE_MODEL_CONFIG = 'save-model-config' as const
export const LOAD_MODEL_CONFIG = 'load-model-config' as const
/** LLM 多服务商注册表 */
export const LOAD_LLM_REGISTRY = 'load-llm-registry' as const
export const SAVE_LLM_REGISTRY = 'save-llm-registry' as const
export const SET_ACTIVE_MODEL = 'set-active-model' as const
export const FETCH_PROVIDER_MODELS = 'fetch-provider-models' as const
export const SET_MODE = 'set-mode' as const
export const ACCEPT_FILE = 'accept-file' as const
export const REJECT_FILE = 'reject-file' as const
export const RESPOND_PERMISSION = 'respond-permission' as const
export const RESPOND_VERIFICATION_PERMISSION = 'respond-verification-permission' as const
export const RESPOND_ASK_QUESTION = 'respond-ask-question' as const
export const LOAD_SESSIONS = 'load-sessions' as const
export const LOAD_SESSION = 'load-session' as const
export const LOAD_SESSION_MESSAGES = 'load-session-messages' as const
export const CREATE_SESSION = 'create-session' as const
export const DELETE_SESSION = 'delete-session' as const
export const GET_MESSAGE_DIFFS = 'get-message-diffs' as const
export const WINDOW_MINIMIZE = 'window-minimize' as const
export const WINDOW_MAXIMIZE = 'window-maximize' as const
export const WINDOW_CLOSE = 'window-close' as const
export const WINDOW_IS_MAXIMIZED = 'window-is-maximized' as const
// ── Workspace 单一事实源（PRD §5.1） ──────────────────────
/** 读取当前工作区状态 */
export const WORKSPACE_GET = 'workspace:get' as const
/** 选择项目（弹文件夹对话框或指定路径），自动创建会话 */
export const WORKSPACE_SELECT_PROJECT = 'workspace:select-project' as const
/** 显式创建新会话 */
export const WORKSPACE_CREATE_SESSION = 'workspace:create-session' as const
/** 删除会话（删除当前会话时自动切到下一条或清空） */
export const WORKSPACE_DELETE_SESSION = 'workspace:delete-session' as const
/** 重命名会话标题 */
export const WORKSPACE_RENAME_SESSION = 'workspace:rename-session' as const
/** 切换当前会话 */
export const WORKSPACE_SELECT_SESSION = 'workspace:select-session' as const
/** 切换运行模式 */
export const WORKSPACE_SET_MODE = 'workspace:set-mode' as const
/** 重新生成助手消息（分叉准备：undo 文件 + 倒回 currentLeafId 到父 user） */
export const WORKSPACE_REGENERATE = 'workspace:regenerate' as const
/** 切换兄弟分支（LCA 文件 undo + setCurrentLeaf） */
export const WORKSPACE_SWITCH_BRANCH = 'workspace:switch-branch' as const
/** 递增 messagesRevision，触发 renderer 同会话重拉（分叉完成补 branch 元信息 / desync 纠正） */
export const WORKSPACE_BUMP_MESSAGES_REVISION = 'workspace:bump-messages-revision' as const
/** 编辑用户消息并重发（分叉准备：undo 文件 + 倒回 currentLeafId 到分叉点） */
export const WORKSPACE_EDIT_RESEND = 'workspace:edit-resend' as const
// ── 存储治理（WS3 后端） ──────────────────────
export const STORAGE_USAGE = 'storage:usage' as const
export const STORAGE_PRUNE_SESSION_CHECKPOINTS = 'storage:prune-session-checkpoints' as const
export const STORAGE_PRUNE_ALL_CHECKPOINTS = 'storage:prune-all-checkpoints' as const
export const STORAGE_DELETE_SESSION = 'storage:delete-session' as const
export const STORAGE_RUN_GC = 'storage:run-gc' as const
// ── 权限持久化规则（PRD §5.2） ──────────────────────
export const PERMISSION_LIST = 'permission:list' as const
export const PERMISSION_UPSERT = 'permission:upsert' as const
export const PERMISSION_DELETE = 'permission:delete' as const
export const PERMISSION_GRANT_SESSION_SCOPE = 'permission:grant-session-scope' as const
// ── DiffViewer 批量审阅（PRD §5.3） ──────────────────────
export const ACCEPT_ALL_FILES = 'accept-all-files' as const
export const REJECT_ALL_FILES = 'reject-all-files' as const
// ── 编排模式 compose ──────────────────────
export const COMPOSE_RUN = 'compose:run' as const
export const COMPOSE_CANCEL = 'compose:cancel' as const
export const COMPOSE_STATUS = 'compose:status' as const
export const COMPOSE_RESUME = 'compose:resume' as const
/** 回复编排 askUser（解除脚本阻塞） */
export const COMPOSE_RESPOND_ASK_USER = 'compose:respond-ask-user' as const
/** 读取当前工作区 `.nova/compose/state.json` */
export const COMPOSE_GET_STATE = 'compose:get-state' as const
/** 跨会话记忆：列出 scope 下 md 文件 */
export const MEMORY_LIST_FILES = 'memory:list-files' as const
export const MEMORY_READ_FILE = 'memory:read-file' as const
export const MEMORY_WRITE_FILE = 'memory:write-file' as const
export const MEMORY_RECONCILE = 'memory:reconcile' as const
export const MEMORY_STATS = 'memory:stats' as const
/** 在系统文件管理器中打开当前 scope 记忆目录 */
export const MEMORY_OPEN_DIR = 'memory:open-dir' as const

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
export const AGENT_ASK_QUESTION_REQUEST = 'agent:ask-question-request' as const
export const AGENT_ASK_QUESTION_RESOLVED = 'agent:ask-question-resolved' as const
export const AGENT_DIFF_UPDATE = 'agent:diff-update' as const
export const AGENT_VERIFICATION_RESULT = 'agent:verification-result' as const
export const AGENT_TODOS_UPDATED = 'agent:todos-updated' as const
export const AGENT_ERROR = 'agent:error' as const
export const AGENT_MESSAGE_END = 'agent:message-end' as const
export const AGENT_THINKING_DELTA = 'agent:thinking-delta' as const
export const AGENT_USAGE = 'agent:usage' as const
export const AGENT_CONTEXT_BREAKDOWN = 'agent:context-breakdown' as const
export const AGENT_HOOK_ERROR = 'agent:hook-error' as const
export const AGENT_RECOVERY_HINT = 'agent:recovery-hint' as const
export const AGENT_RECOVERY_STATE = 'agent:recovery-state' as const
export const AGENT_MODEL_SWITCHED = 'agent:model-switched' as const
export const WINDOW_MAXIMIZE_CHANGE = 'window:maximize-change' as const
export const SKILL_CHANGED = 'skill:changed' as const
/** 工作区状态变更广播（PRD §5.1） */
export const WORKSPACE_CHANGED = 'workspace:changed' as const
/** 编排 phase / task / log / ask-user */
export const COMPOSE_PHASE_CHANGE = 'compose:phase-change' as const
export const COMPOSE_TASK_UPDATE = 'compose:task-update' as const
export const COMPOSE_ASK_USER = 'compose:ask-user' as const
export const COMPOSE_LOG = 'compose:log' as const
export const COMPOSE_STATE = 'compose:state' as const
