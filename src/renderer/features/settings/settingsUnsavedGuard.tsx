/**
 * 设置壳的未保存守卫：草稿仍由各面板持有，面板只登记“是否有未保存修改”的查询，
 * 壳层在离开设置前统一询问。脱离设置壳单独渲染面板时守卫为空操作。
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { confirmDialog } from '../confirm/confirmDialog'

type DirtyQuery = () => boolean

interface SettingsUnsavedGuardApi {
  register: (id: string, isDirty: DirtyQuery) => () => void
  /** 离开设置前调用：无未保存修改或用户确认放弃时返回 true */
  confirmLeave: () => Promise<boolean>
}

const SettingsUnsavedGuardContext = createContext<SettingsUnsavedGuardApi | null>(null)

async function confirmDiscardUnsaved(): Promise<boolean> {
  const choice = await confirmDialog({
    type: 'warning',
    title: '放弃未保存的修改？',
    message: '设置中还有未保存的修改，离开后这些修改会丢失。',
    buttons: ['继续编辑', '放弃修改'],
    defaultId: 0,
    cancelId: 0
  })
  return choice === 1
}

/** 壳层持有登记表；只在离开前按需查询，草稿变化不会让壳层重渲染。 */
export function useSettingsUnsavedRegistry(): SettingsUnsavedGuardApi {
  const queries = useRef(new Map<string, DirtyQuery>())
  return useMemo(() => ({
    register: (id, isDirty) => {
      queries.current.set(id, isDirty)
      return () => {
        if (queries.current.get(id) === isDirty) queries.current.delete(id)
      }
    },
    confirmLeave: async () => {
      const hasUnsaved = [...queries.current.values()].some(isDirty => isDirty())
      return hasUnsaved ? confirmDiscardUnsaved() : true
    }
  }), [])
}

export function SettingsUnsavedGuardProvider(props: { api: SettingsUnsavedGuardApi; children: ReactNode }) {
  return (
    <SettingsUnsavedGuardContext.Provider value={props.api}>
      {props.children}
    </SettingsUnsavedGuardContext.Provider>
  )
}

/** 面板登记自己的未保存状态；读最新值走 ref，避免每次输入都重新登记。 */
export function useSettingsUnsavedGuard(id: string, isDirty: boolean): void {
  const guard = useContext(SettingsUnsavedGuardContext)
  const latest = useRef(isDirty)
  latest.current = isDirty
  useEffect(() => guard?.register(id, () => latest.current), [guard, id])
}

/** 面板内会离开设置的操作（如“使用技能”）先经此确认。 */
export function useSettingsLeaveConfirm(): () => Promise<boolean> {
  const guard = useContext(SettingsUnsavedGuardContext)
  return guard ? guard.confirmLeave : () => Promise.resolve(true)
}
