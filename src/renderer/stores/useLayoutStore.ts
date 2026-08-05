/**
 * 三段式布局 UI 状态的唯一 Owner（Sidebar / Inspector 开合与宽度）。
 * 不持久化 inspectorOpen / reviewTarget，避免重启后误开审阅面板。
 */
import { create } from 'zustand'

export type InspectorTab = 'review' | 'files'

export type ReviewTarget = {
  messageId: string
  filePath?: string
}

const STORAGE_PREFIX = 'nova.layout.'
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 400
const INSPECTOR_WIDTH_MIN = 320
const INSPECTOR_WIDTH_MAX = 640

const DEFAULTS = {
  sidebarCollapsed: false,
  sidebarWidth: 264,
  inspectorOpen: false,
  inspectorTab: 'review' as InspectorTab,
  inspectorWidth: 420,
  reviewTarget: null as ReviewTarget | null
}

function canUseLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function readStored(key: string): string | null {
  if (!canUseLocalStorage()) return null
  try {
    return localStorage.getItem(STORAGE_PREFIX + key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  if (!canUseLocalStorage()) return
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value)
  } catch {
    // quota / private mode：忽略，内存态仍可用
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function loadPersistedLayout(): Pick<
  typeof DEFAULTS,
  'sidebarCollapsed' | 'sidebarWidth' | 'inspectorWidth' | 'inspectorTab'
> {
  const collapsedRaw = readStored('sidebarCollapsed')
  const sidebarWidthRaw = readStored('sidebarWidth')
  const inspectorWidthRaw = readStored('inspectorWidth')
  const tabRaw = readStored('inspectorTab')

  let sidebarCollapsed = DEFAULTS.sidebarCollapsed
  if (collapsedRaw === 'true') sidebarCollapsed = true
  else if (collapsedRaw === 'false') sidebarCollapsed = false

  let sidebarWidth = DEFAULTS.sidebarWidth
  if (sidebarWidthRaw !== null) {
    const n = Number(sidebarWidthRaw)
    if (Number.isFinite(n)) sidebarWidth = clamp(n, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  }

  let inspectorWidth = DEFAULTS.inspectorWidth
  if (inspectorWidthRaw !== null) {
    const n = Number(inspectorWidthRaw)
    if (Number.isFinite(n)) inspectorWidth = clamp(n, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
  }

  let inspectorTab: InspectorTab = DEFAULTS.inspectorTab
  if (tabRaw === 'review' || tabRaw === 'files') inspectorTab = tabRaw

  return { sidebarCollapsed, sidebarWidth, inspectorWidth, inspectorTab }
}

export interface LayoutStoreState {
  sidebarCollapsed: boolean
  sidebarWidth: number
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  inspectorWidth: number
  reviewTarget: ReviewTarget | null

  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  openReview: (target: ReviewTarget) => void
  openFiles: () => void
  closeInspector: () => void
  toggleInspector: (tab?: InspectorTab) => void
  setInspectorWidth: (w: number) => void
  setInspectorTab: (tab: InspectorTab) => void
  selectReviewFile: (filePath: string) => void
}

const persisted = loadPersistedLayout()

export const useLayoutStore = create<LayoutStoreState>((set, get) => ({
  ...DEFAULTS,
  ...persisted,

  toggleSidebar: () => {
    set((state) => {
      const sidebarCollapsed = !state.sidebarCollapsed
      writeStored('sidebarCollapsed', String(sidebarCollapsed))
      return { sidebarCollapsed }
    })
  },

  setSidebarWidth: (w) => {
    const sidebarWidth = clamp(w, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
    writeStored('sidebarWidth', String(sidebarWidth))
    set({ sidebarWidth })
  },

  openReview: (target) => {
    writeStored('inspectorTab', 'review')
    set({ inspectorOpen: true, inspectorTab: 'review', reviewTarget: target })
  },

  openFiles: () => {
    writeStored('inspectorTab', 'files')
    set({ inspectorOpen: true, inspectorTab: 'files' })
  },

  closeInspector: () => {
    set({ inspectorOpen: false })
  },

  toggleInspector: (tab) => {
    const state = get()
    if (tab === undefined) {
      set({ inspectorOpen: !state.inspectorOpen })
      return
    }
    if (state.inspectorOpen && state.inspectorTab === tab) {
      set({ inspectorOpen: false })
      return
    }
    writeStored('inspectorTab', tab)
    set({ inspectorOpen: true, inspectorTab: tab })
  },

  setInspectorWidth: (w) => {
    const inspectorWidth = clamp(w, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
    writeStored('inspectorWidth', String(inspectorWidth))
    set({ inspectorWidth })
  },

  setInspectorTab: (tab) => {
    writeStored('inspectorTab', tab)
    set({ inspectorTab: tab })
  },

  selectReviewFile: (filePath) => {
    const { reviewTarget } = get()
    if (reviewTarget === null) return
    set({ reviewTarget: { ...reviewTarget, filePath } })
  }
}))

/** 测试用：清空持久化后恢复默认布局态 */
export function resetLayoutStoreForTests(): void {
  if (canUseLocalStorage()) {
    try {
      for (const key of ['sidebarCollapsed', 'sidebarWidth', 'inspectorWidth', 'inspectorTab']) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      }
    } catch {
      // ignore
    }
  }
  useLayoutStore.setState({ ...DEFAULTS })
}
