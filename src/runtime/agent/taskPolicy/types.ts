/** 任务复杂度分级：影响约束提示与工具经济开关 */
export type TaskPolicyTier = 'economy' | 'default' | 'heavy'

/** 策略消费面：headless 可注入硬约束；interactive 仅返回分级结果，不产生任何注入文案 */
export type TaskPolicySurface = 'headless' | 'interactive'

/** 触发分级的信号来源 */
export type TaskPolicyMatchSource = 'config' | 'metadata' | 'instruction'

export interface TaskPolicySignals {
  instruction: string
  surface: TaskPolicySurface
  /** 显式开启 economy */
  economyTaskMode?: boolean
  /** 显式开启 heavy（与 economy 互斥时优先） */
  heavyTaskMode?: boolean
  /** 任务/评测元数据 category */
  category?: string
  /** 任务/评测元数据 tags */
  tags?: readonly string[]
}

export interface ResolvedTaskPolicy {
  tier: TaskPolicyTier
  matchedBy: TaskPolicyMatchSource[]
  /** headless + economy/heavy 时的 system 层硬约束；其余为空 */
  systemLayerText: string
  /** 是否启用工具分组过滤 */
  toolEconomy: boolean
}
