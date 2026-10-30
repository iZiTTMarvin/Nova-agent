/**
 * 技能目录快照 store — 设置页、`+` 入口与 composer `/` trigger 共享数据源。
 * 快照由主进程组装推送，本 store 只做只读持有，不自判权限与冲突。
 */
import { create } from 'zustand'
import type {
  SkillCatalogDiagnostic,
  SkillCatalogSnapshot,
  SkillSummary,
  ThirdPartySkillSourceStatus
} from '../../../shared/skills/types'

interface SkillsStoreState {
  skills: SkillSummary[]
  loading: boolean
  error: string | null
  refreshedAt: number | null
  diagnostics: SkillCatalogDiagnostic[]
  /** 第三方来源（.agents / .claude）的开关状态与检测结果 */
  thirdPartySources: ThirdPartySkillSourceStatus[]
  /** 从 IPC 拉取并更新 */
  refresh: () => Promise<void>
  /** 写入主进程推送的快照（skill:changed） */
  setSnapshot: (snapshot: SkillCatalogSnapshot) => void
}

export const useSkillsStore = create<SkillsStoreState>((set) => ({
  skills: [],
  loading: false,
  error: null,
  refreshedAt: null,
  diagnostics: [],
  thirdPartySources: [],

  refresh: async () => {
    try {
      const snapshot = await window.nova.skill.list()
      set({ ...snapshot })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  setSnapshot: (snapshot) => set({ ...snapshot })
}))

/** 过滤用户可 slash 调用的技能 */
export function toUserInvocableSkills(skills: SkillSummary[]): SkillSummary[] {
  return skills.filter(s => s.userInvocable && !s.invalid && !s.hidden)
}
