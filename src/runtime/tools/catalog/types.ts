/**
 * Tool Catalog 类型：产品工具元数据的唯一事实源。
 * Catalog 只描述策略元数据（可见性、分组、能力标签），不承载实现、权限判定或执行。
 */

/** availability 策略：工具如何进入模型可见面 */
export type ToolExposure =
  /** 常驻可见（注册即对模型可见） */
  | 'always'
  /** 可见性由模式策略投影决定（save_plan / switch_mode / stage_transition） */
  | 'mode-bound'
  /** 延迟暴露：所属组激活后才可见 */
  | 'deferred'
  /** Harness 内部控制动作：仅 Tool Economy 开启时作为连接器下发，不作为常驻产品工具 */
  | 'internal'

/**
 * 稳定能力标签：用于诊断、能力投影与一致性校验，不用于语义检索。
 * 与 shared/permissions/toolEffects 的权限 effects 是两个正交维度；
 * 一致性由 catalog 覆盖测试保证（shared 不得反向依赖 runtime）。
 */
export type ToolCapabilityTag =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'shell'
  | 'web'
  | 'memory'
  | 'skill'
  | 'agent'
  | 'plan'
  | 'compose'
  | 'mode'
  | 'interaction'
  | 'archive'
  | 'internal'

/** Code Mode 嵌套策略：决定工具是进入只读 SDK 还是仅允许模型直调。 */
export type ToolCodeModeNesting = 'nestable-readonly' | 'direct-only'

export interface ToolCatalogEntry {
  readonly name: string
  readonly capability: ToolCapabilityTag
  readonly exposure: ToolExposure
  /** exposure=deferred 时必须存在 */
  readonly groupId?: string
  /** Code Mode 是否允许作为嵌套工具 */
  readonly codeMode: ToolCodeModeNesting
  /**
   * 注册策略：conditional 表示该工具可按宿主配置合法缺席注册清单
   * 缺省 always 的工具必须注册。
   */
  readonly registration?: 'always' | 'conditional'
}

/** 延迟能力组元数据；成员归属由 entry.groupId 表达，此处只放组级展示信息 */
export interface DeferredToolGroupMeta {
  readonly id: string
  /** 面向 load_tools 描述的组标签 */
  readonly label: string
  /** 面向模型的一句话能力说明（字节级稳定，不嵌入激活状态） */
  readonly description: string
  /** 预留组：尚无成员工具，绝不进入 load_tools enum / description */
  readonly reserved: boolean
}
