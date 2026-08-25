/**
 * 权限领域的共享契约。
 * 运行时规则对象仍在 runtime/permissions；此处只放跨层类型，避免 shared 反向依赖 runtime。
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny'

export type PermissionBehavior = 'allow' | 'deny'

export type ToolEffect =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'shell.execute'
  | 'process.control'
  | 'network.read'
  | 'network.write'
  | 'session.write'
  | 'orchestration'
  | 'mode.transition'

export interface ToolPermissionDescriptor {
  /** 静态声明可能产生的副作用；实际生效的 effects 由 args 动态解析 */
  effects: readonly ToolEffect[]
  pathScope?: 'workspace' | 'dynamic' | 'none'
  risk?: 'low' | 'dynamic'
  /** Plan 下唯一允许的文件写入（工作区计划文档） */
  planArtifact?: boolean
}

export type PathAccessKind = 'read' | 'write'

export interface SessionPathGrant {
  canonicalRoot: string
  access: PathAccessKind
  match: 'exact' | 'subtree'
  origin: 'user' | 'skill'
}

/** IPC 传输用的规则载荷（与 runtime PermissionRule 结构对齐，但不携带运行时方法） */
export interface PermissionRuleDto {
  id: string
  toolName: string
  behavior: PermissionBehavior
  scope: 'global' | 'project'
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
  createdAt: number
}

/** 列出规则参数 */
export interface PermissionListParams {
  /** 当前项目路径，用于返回项目级 + 全局规则合集；为空只返回全局 */
  projectPath?: string | null
}

/** 新增/更新规则参数 */
export interface PermissionUpsertParams {
  toolName: string
  behavior: PermissionBehavior
  scope: 'global' | 'project'
  /** 项目级规则必填；主进程校验必须是当前打开项目 */
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
}

/** 删除规则参数 */
export interface PermissionDeleteParams {
  ruleId: string
  projectPath?: string | null
}
