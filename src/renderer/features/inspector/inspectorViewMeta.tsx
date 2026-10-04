/** 面板视图的展示信息（标签名与图标），标签条与内容窗格共用。 */
import type { ReactNode } from 'react'
import { FolderIcon, GlobeIcon, UserCheckIcon, PlanIcon } from '../../components/Icons'
import type { InspectorViewKey } from '../../stores/useLayoutStore'

export const VIEW_META: Record<InspectorViewKey, { name: string; icon: ReactNode }> = {
  review: { name: '审阅', icon: <UserCheckIcon size={14} /> },
  files: { name: '工作区文件', icon: <FolderIcon size={14} /> },
  browser: { name: '内置浏览器', icon: <GlobeIcon size={14} /> },
  outline: { name: '大纲', icon: <PlanIcon size={14} /> }
}
