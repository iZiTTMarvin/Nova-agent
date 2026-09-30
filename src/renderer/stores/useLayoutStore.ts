/**
 * 布局 UI 状态的唯一 Owner（Sidebar / Inspector 面板的开合、页签与宽度）。
 * 不持久化 inspectorOpen / reviewTarget，避免重启后误开；浏览器页签也不持久化。
 */
import { create } from 'zustand'

/** 开发面板页签；browser = 内置浏览器（用户页与 AI 页共用同一面板）。 */
export type InspectorTab = 'review' | 'files' | 'browser'
/** 学习会话的面板页签：大纲取代审阅（审阅对学习会话没有意义）。 */
export type LearnInspectorTab = 'outline' | 'files' | 'browser'
export type InspectorSurface = 'standard' | 'plan'

export type ReviewTarget = {
  messageId: string
  filePath?: string
}

export type PlanTarget = {
  sessionId: string
  messageId: string
  toolCallId: string
  expectedPath?: string
}

type PlanReturnState = {
  inspectorOpen: boolean
  inspectorTab: InspectorTab
}

export type SidebarSortMode = 'projects' | 'sessions'

const STORAGE_PREFIX = 'nova.layout.'

/** 首次进入学习且没有存储值时，窗口不小于该宽度才默认展开大纲。 */
export const LEARN_INSPECTOR_AUTO_OPEN_MIN_WIDTH = 1280

/** 拖拽 clamp 与面板实现共享的宽度边界 */
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 400
export const INSPECTOR_WIDTH_MIN = 320
export const INSPECTOR_WIDTH_MAX = 720
/** 浏览器页签激活时面板的最小宽度（地址栏与舞台的可用下限）。 */
export const BROWSER_PANE_WIDTH_MIN = 360

const DEFAULTS = {
  sidebarCollapsed: false,
  sidebarWidth: 264,
  sidebarSortMode: 'projects' as SidebarSortMode,
  inspectorOpen: false,
  inspectorTab: 'review' as InspectorTab,
  inspectorWidth: 420,
  reviewTarget: null as ReviewTarget | null,
  inspectorSurface: 'standard' as InspectorSurface,
  planTarget: null as PlanTarget | null,
  planReturnState: null as PlanReturnState | null,
  learnInspectorOpen: false,
  learnInspectorTab: 'outline' as LearnInspectorTab
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
  'sidebarCollapsed' | 'sidebarWidth' | 'sidebarSortMode' | 'inspectorWidth' | 'inspectorTab' | 'learnInspectorOpen' | 'learnInspectorTab'
> {
  const collapsedRaw = readStored('sidebarCollapsed')
  const sidebarWidthRaw = readStored('sidebarWidth')
  const sortModeRaw = readStored('sidebarSortMode')
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

  let sidebarSortMode: SidebarSortMode = DEFAULTS.sidebarSortMode
  if (sortModeRaw === 'projects' || sortModeRaw === 'sessions') {
    sidebarSortMode = sortModeRaw
  }

  let inspectorWidth = DEFAULTS.inspectorWidth
  if (inspectorWidthRaw !== null) {
    const n = Number(inspectorWidthRaw)
    if (Number.isFinite(n)) inspectorWidth = clamp(n, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
  }

  let inspectorTab: InspectorTab = DEFAULTS.inspectorTab
  if (tabRaw === 'review' || tabRaw === 'files') inspectorTab = tabRaw

  // 学习面板与开发面板是两个表面各自的状态；学习面板的开合要记住，开发面板照旧不记
  const learnOpenRaw = readStored('learnInspectorOpen')
  const learnInspectorOpen = learnOpenRaw === 'true' ? true : learnOpenRaw === 'false' ? false
    : typeof window !== 'undefined' && window.innerWidth >= LEARN_INSPECTOR_AUTO_OPEN_MIN_WIDTH
  const learnTabRaw = readStored('learnInspectorTab')
  const learnInspectorTab: LearnInspectorTab = learnTabRaw === 'files' ? 'files' : 'outline'

  return { sidebarCollapsed, sidebarWidth, sidebarSortMode, inspectorWidth, inspectorTab, learnInspectorOpen, learnInspectorTab }
}

export interface LayoutStoreState {
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarSortMode: SidebarSortMode
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  inspectorWidth: number
  reviewTarget: ReviewTarget | null
  inspectorSurface: InspectorSurface
  planTarget: PlanTarget | null
  planReturnState: PlanReturnState | null
  learnInspectorOpen: boolean
  learnInspectorTab: LearnInspectorTab

  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setSidebarSortMode: (mode: SidebarSortMode) => void
  openReview: (target: ReviewTarget) => void
  openFiles: () => void
  openPlan: (target: PlanTarget) => void
  closeInspector: () => void
  toggleInspector: (tab?: InspectorTab) => void
  setInspectorWidth: (w: number) => void
  setInspectorTab: (tab: InspectorTab) => void
  selectReviewFile: (filePath: string) => void
  openBrowserPane: (isLearnSurface: boolean) => void
  toggleBrowserPane: (isLearnSurface: boolean) => void
  toggleLearnInspector: () => void
  setLearnInspectorTab: (tab: LearnInspectorTab) => void
  openOutline: () => void
  closeLearnInspector: () => void
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

  setSidebarSortMode: (sidebarSortMode) => {
    writeStored('sidebarSortMode', sidebarSortMode)
    set({ sidebarSortMode })
  },

  openReview: (target) => {
    writeStored('inspectorTab', 'review')
    set({
      inspectorOpen: true,
      inspectorTab: 'review',
      reviewTarget: target,
      inspectorSurface: 'standard',
      planTarget: null,
      planReturnState: null
    })
  },

  openFiles: () => {
    writeStored('inspectorTab', 'files')
    set({
      inspectorOpen: true,
      inspectorTab: 'files',
      inspectorSurface: 'standard',
      planTarget: null,
      planReturnState: null
    })
  },

  openPlan: (target) => {
    const state = get()
    set({
      inspectorOpen: true,
      inspectorSurface: 'plan',
      planTarget: target,
      planReturnState: state.inspectorSurface === 'plan'
        ? state.planReturnState
        : { inspectorOpen: state.inspectorOpen, inspectorTab: state.inspectorTab }
    })
  },

  closeInspector: () => {
    const state = get()
    if (state.inspectorSurface === 'plan') {
      const restore = state.planReturnState
      set({
        inspectorOpen: restore?.inspectorOpen ?? false,
        inspectorTab: restore?.inspectorTab ?? state.inspectorTab,
        inspectorSurface: 'standard',
        planTarget: null,
        planReturnState: null
      })
      return
    }
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
  },

  /** 打开右侧面板并切到浏览器页签；作用域由调用方按当前表面传入。 */
  openBrowserPane: (isLearnSurface) => {
    if (isLearnSurface) {
      set({ learnInspectorOpen: true, learnInspectorTab: 'browser' })
      return
    }
    set({
      inspectorOpen: true,
      inspectorTab: 'browser',
      // 计划表面没有页签条，先回标准表面浏览器才可见
      inspectorSurface: 'standard',
      planTarget: null,
      planReturnState: null
    })
  },

  /** 浏览器页签是否已激活：激活时再触发就收起面板（顶栏按钮与快捷键共用）。 */
  toggleBrowserPane: (isLearnSurface) => {
    const state = get()
    const active = isLearnSurface
      ? state.learnInspectorOpen && state.learnInspectorTab === 'browser'
      : state.inspectorOpen && state.inspectorTab === 'browser'
    if (active) {
      if (isLearnSurface) set({ learnInspectorOpen: false })
      else set({ inspectorOpen: false })
      return
    }
    get().openBrowserPane(isLearnSurface)
  },

  toggleLearnInspector: () => {
    const learnInspectorOpen = !get().learnInspectorOpen
    writeStored('learnInspectorOpen', String(learnInspectorOpen))
    set({ learnInspectorOpen })
  },

  setLearnInspectorTab: (learnInspectorTab) => {
    if (learnInspectorTab !== 'browser') writeStored('learnInspectorTab', learnInspectorTab)
    set({ learnInspectorTab })
  },

  openOutline: () => {
    writeStored('learnInspectorOpen', 'true')
    writeStored('learnInspectorTab', 'outline')
    set({ learnInspectorOpen: true, learnInspectorTab: 'outline' })
  },

  closeLearnInspector: () => {
    writeStored('learnInspectorOpen', 'false')
    set({ learnInspectorOpen: false })
  }
}))

/** 当前表面的面板是否打开：学习会话读学习那组状态，其余读开发那组。 */
export function selectInspectorOpenForSurface(state: LayoutStoreState, isLearnSurface: boolean): boolean {
  return isLearnSurface ? state.learnInspectorOpen : state.inspectorOpen
}

/** 浏览器页签是否为当前表面的激活页签（guest 层据此决定 webview 可见性）。 */
export function selectBrowserPaneActive(state: LayoutStoreState, isLearnSurface: boolean): boolean {
  return isLearnSurface
    ? state.learnInspectorOpen && state.learnInspectorTab === 'browser'
    : state.inspectorOpen && state.inspectorTab === 'browser'
}

/** 测试用：清空持久化后恢复默认布局态 */
export function resetLayoutStoreForTests(): void {
  if (canUseLocalStorage()) {
    try {
      for (const key of [
        'sidebarCollapsed',
        'sidebarWidth',
        'sidebarSortMode',
        'inspectorWidth',
        'inspectorTab',
        'learnInspectorOpen',
        'learnInspectorTab'
      ]) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      }
    } catch {
      // ignore
    }
  }
  useLayoutStore.setState({ ...DEFAULTS })
}
