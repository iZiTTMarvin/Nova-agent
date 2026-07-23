/**
 * 技能列表轻量 store — 设置页与 SkillAC 共享数据源
 */
import { create } from 'zustand'
import type { SkillSummary } from '../../../shared/skills/types'

interface SkillsStoreState {
  skills: SkillSummary[]
  loading: boolean
  /** 从 IPC 拉取并更新 */
  refresh: () => Promise<void>
  setSkills: (skills: SkillSummary[]) => void
}

export const useSkillsStore = create<SkillsStoreState>((set) => ({
  skills: [],
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const list = await window.nova.skill.list()
      set({ skills: list, loading: false })
    } catch (err) {
      console.error('[SkillsStore] 技能列表加载失败:', err)
      set({ loading: false })
    }
  },

  setSkills: (skills) => set({ skills })
}))

/** 过滤用户可 slash 调用的技能 */
export function toUserInvocableSkills(skills: SkillSummary[]): SkillSummary[] {
  return skills.filter(s => s.userInvocable && !s.invalid && !s.hidden)
}
