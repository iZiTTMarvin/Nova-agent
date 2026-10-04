/**
 * 当前表面（学习 / 开发）的面板标签：读已打开标签与激活标签，并把激活 / 关闭路由到对应那组 store 状态。
 * 两组状态的类型不同，类型守卫集中在这里，调用方只面对统一的视图键。
 */
import { useCallback } from 'react'
import {
  isInspectorTab,
  isLearnInspectorTab,
  selectActiveInspectorTab,
  useLayoutStore,
  type InspectorViewKey
} from '../../stores/useLayoutStore'

export function useInspectorTabs(isLearn: boolean) {
  const tabs: readonly InspectorViewKey[] = useLayoutStore(s => (isLearn ? s.learnInspectorTabs : s.inspectorTabs))
  const activeTab = useLayoutStore(s => selectActiveInspectorTab(s, isLearn))

  const activate = useCallback((key: InspectorViewKey) => {
    const layout = useLayoutStore.getState()
    if (isLearn) {
      if (isLearnInspectorTab(key)) layout.setLearnInspectorTab(key)
    } else if (isInspectorTab(key)) {
      layout.setInspectorTab(key)
    }
  }, [isLearn])

  const close = useCallback((key: InspectorViewKey) => {
    const layout = useLayoutStore.getState()
    if (isLearn) {
      if (isLearnInspectorTab(key)) layout.closeLearnInspectorTab(key)
    } else if (isInspectorTab(key)) {
      layout.closeInspectorTab(key)
    }
  }, [isLearn])

  return { tabs, activeTab, activate, close }
}
