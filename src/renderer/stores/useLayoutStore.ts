/**
 * 布局 UI 状态的唯一 Owner（Sidebar / Inspector 面板的开合、页签与宽度）。
 * 不持久化 inspectorOpen / reviewTarget，避免重启后误开；浏览器页签也不持久化。
 */
import { create } from 'zustand'

/** 开发面板页签；browser = 内置浏览器（用户页与 AI 页共用同一面板）。 */
export type InspectorTab = 'review' | 'files' | 'browser'
/** 学习会话的面板页签：大纲取代审阅（审阅对学习会话没有意义）。 */
export type LearnInspectorTab = 'outline' | 'files' | 'browser'
export type InspectorSurface = 'standard' | 'plan' | 'subagent' | 'status'
/** 两个表面的页签键并集，供跨表面的标签条按键渲染。 */
export type InspectorViewKey = InspectorTab | LearnInspectorTab

export function isInspectorTab(key: InspectorViewKey): key is InspectorTab {
  return key === 'review' || key === 'files' || key === 'browser'
}

export function isLearnInspectorTab(key: InspectorViewKey): key is LearnInspectorTab {
  return key === 'outline' || key === 'files' || key === 'browser'
}

export type ReviewTarget = {
  messageId: string
  filePath?: string
}

export type PlanTarget = {
  sessionId: string
  messageId?: string
  toolCallId?: string
  expectedPath?: string
}

export type SubagentTarget = {
  parentSessionId: string
  childSessionId: string
}

type DetailReturnState = {
  inspectorOpen: boolean
  inspectorTab: InspectorTab
}

/**
 * 因会话页面自动打开浏览器之前的面板布局，仅用于切到没有任何页面的会话时恢复。
 * 属于布局的界面上下文，不复制页面事实；用户自己改动面板的任何操作都会丢弃它。
 */
type BrowserAutoOpenRestore =
  | {
      scope: 'dev'
      inspectorOpen: boolean
      inspectorTab: InspectorTab
      inspectorTabs: readonly InspectorTab[]
      inspectorSurface: InspectorSurface
      planTarget: PlanTarget | null
      subagentTarget: SubagentTarget | null
      statusSessionId: string | null
      detailReturnState: DetailReturnState | null
    }
  | {
      scope: 'learn'
      learnInspectorOpen: boolean
      learnInspectorTab: LearnInspectorTab
      learnInspectorTabs: readonly LearnInspectorTab[]
    }

/** 用户主动改动面板：自动打开的恢复点随之作废，避免之后把用户的选择当成“自动状态”收回。 */
const USER_OWNS_PANE = { browserAutoOpenRestore: null } as const

export type SidebarSortMode = 'projects' | 'sessions'

const STORAGE_PREFIX = 'nova.layout.'

/** 首次进入学习且没有存储值时，窗口不小于该宽度才默认展开大纲。 */
export const LEARN_INSPECTOR_AUTO_OPEN_MIN_WIDTH = 1280

/** 拖拽 clamp 与面板实现共享的宽度边界与默认值 */
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 400
export const SIDEBAR_WIDTH_DEFAULT = 264
export const SIDEBAR_COLLAPSE_THRESHOLD_PX = 120
export const INSPECTOR_WIDTH_MIN = 320
export const INSPECTOR_WIDTH_MAX = 720
export const INSPECTOR_WIDTH_DEFAULT = 420
export const INSPECTOR_COLLAPSE_THRESHOLD_PX = 180
/** 浏览器页签激活时面板的最小宽度（地址栏与舞台的可用下限）。 */
export const BROWSER_PANE_WIDTH_MIN = 360
/** 阅读柱宽下限 = global.css 的 --chat-content-max-width 初始值 48rem（root 16px）。
   拖拽只能从此值向宽调；实际上限由容器剩余宽度在使用处钳制，这里只兜防呆上限。 */
export const CHAT_CONTENT_WIDTH_MIN = 768
export const CHAT_CONTENT_WIDTH_MAX = 3840

const DEFAULTS = {
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  sidebarSortMode: 'projects' as SidebarSortMode,
  inspectorOpen: false,
  inspectorTab: 'review' as InspectorTab,
  inspectorWidth: INSPECTOR_WIDTH_DEFAULT,
  reviewTarget: null as ReviewTarget | null,
  inspectorSurface: 'standard' as InspectorSurface,
  planTarget: null as PlanTarget | null,
  subagentTarget: null as SubagentTarget | null,
  statusSessionId: null as string | null,
  detailReturnState: null as DetailReturnState | null,
  browserAutoOpenRestore: null as BrowserAutoOpenRestore | null,
  learnInspectorOpen: false,
  learnInspectorTab: 'outline' as LearnInspectorTab,
  // 用户拖出的阅读柱宽（px）；null = 跟随默认 --chat-content-max-width
  chatContentWidth: null as number | null,
  // 已打开的视图标签（每种视图至多一个）；为空即面板首页（启动器）。不进持久化，每次启动回首页
  inspectorTabs: [] as readonly InspectorTab[],
  learnInspectorTabs: [] as readonly LearnInspectorTab[],
  // 侧边栏置顶会话与置顶项目的自定义排序 ID 列表
  pinnedSessionOrder: [] as readonly string[],
  pinnedProjectOrder: [] as readonly string[]
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

/** 打开视图标签：已存在则不重复添加。 */
function withTabOpened<T>(tabs: readonly T[], tab: T): readonly T[] {
  return tabs.includes(tab) ? tabs : [...tabs, tab]
}

/** 关闭视图标签；关闭的是激活标签时，激活原位置的邻近标签（优先右侧，其次左侧）。 */
function withTabClosed<T>(tabs: readonly T[], active: T, tab: T): { tabs: readonly T[]; active: T } {
  const index = tabs.indexOf(tab)
  if (index === -1) return { tabs, active }
  const rest = tabs.filter(t => t !== tab)
  if (tab !== active || rest.length === 0) return { tabs: rest, active }
  return { tabs: rest, active: rest[Math.min(index, rest.length - 1)] }
}

/** 浏览器页签不持久化，重启不自动回到浏览器。 */
function persistInspectorTab(tab: InspectorTab): void {
  if (tab !== 'browser') writeStored('inspectorTab', tab)
}

function persistLearnInspectorTab(tab: LearnInspectorTab): void {
  if (tab !== 'browser') writeStored('learnInspectorTab', tab)
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function parseStringArray(raw: string | null): readonly string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

/**
 * 按持久化排序 ID 列表派生置顶项顺序：
 * 已存在于 orderIds 中的项按 orderIds 顺序排列，新置顶但未进入 orderIds 的项保持原相对顺序跟在后面。
 */
export function orderPinnedItems<T>(
  items: readonly T[],
  orderIds: readonly string[],
  getId: (item: T) => string
): T[] {
  if (items.length <= 1 || orderIds.length === 0) return [...items]
  const indexMap = new Map<string, number>()
  orderIds.forEach((id, idx) => {
    if (!indexMap.has(id)) indexMap.set(id, idx)
  })
  return [...items].sort((a, b) => {
    const idxA = indexMap.get(getId(a))
    const idxB = indexMap.get(getId(b))
    if (idxA !== undefined && idxB !== undefined) return idxA - idxB
    if (idxA !== undefined) return -1
    if (idxB !== undefined) return 1
    return 0
  })
}

function loadPersistedLayout(): Pick<
  typeof DEFAULTS,
  | 'sidebarCollapsed'
  | 'sidebarWidth'
  | 'sidebarSortMode'
  | 'inspectorWidth'
  | 'inspectorTab'
  | 'learnInspectorOpen'
  | 'learnInspectorTab'
  | 'chatContentWidth'
  | 'pinnedSessionOrder'
  | 'pinnedProjectOrder'
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
  const pinnedSessionOrder = parseStringArray(readStored('pinnedSessionOrder'))
  const pinnedProjectOrder = parseStringArray(readStored('pinnedProjectOrder'))

  const chatContentWidthRaw = readStored('chatContentWidth')
  const chatContentWidthN = chatContentWidthRaw === null ? NaN : Number(chatContentWidthRaw)
  const chatContentWidth = Number.isFinite(chatContentWidthN)
    ? clamp(chatContentWidthN, CHAT_CONTENT_WIDTH_MIN, CHAT_CONTENT_WIDTH_MAX)
    : DEFAULTS.chatContentWidth

  return {
    sidebarCollapsed,
    sidebarWidth,
    sidebarSortMode,
    inspectorWidth,
    inspectorTab,
    learnInspectorOpen,
    learnInspectorTab,
    chatContentWidth,
    pinnedSessionOrder,
    pinnedProjectOrder
  }
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
  subagentTarget: SubagentTarget | null
  statusSessionId: string | null
  detailReturnState: DetailReturnState | null
  browserAutoOpenRestore: BrowserAutoOpenRestore | null
  learnInspectorOpen: boolean
  learnInspectorTab: LearnInspectorTab
  chatContentWidth: number | null
  inspectorTabs: readonly InspectorTab[]
  learnInspectorTabs: readonly LearnInspectorTab[]
  pinnedSessionOrder: readonly string[]
  pinnedProjectOrder: readonly string[]

  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setSidebarSortMode: (mode: SidebarSortMode) => void
  setPinnedSessionOrder: (order: readonly string[]) => void
  setPinnedProjectOrder: (order: readonly string[]) => void
  openReview: (target: ReviewTarget) => void
  openFiles: () => void
  openPlan: (target: PlanTarget) => void
  openSubagent: (target: SubagentTarget) => void
  openStatus: (sessionId: string) => void
  closeInspector: () => void
  toggleInspector: (tab?: InspectorTab) => void
  setInspectorWidth: (w: number) => void
  setInspectorTab: (tab: InspectorTab) => void
  selectReviewFile: (filePath: string) => void
  openBrowserPane: (isLearnSurface: boolean) => void
  /** 会话自带的 Agent 页面触发的自动打开：记住原布局，之后可由 releaseAutoOpenedBrowserPane 恢复。 */
  autoOpenBrowserPane: (isLearnSurface: boolean) => void
  /** 切到没有任何页面的会话时调用：仅当面板仍是自动打开的结果才恢复原布局。 */
  releaseAutoOpenedBrowserPane: () => void
  toggleBrowserPane: (isLearnSurface: boolean) => void
  toggleLearnInspector: () => void
  setLearnInspectorTab: (tab: LearnInspectorTab) => void
  closeInspectorTab: (tab: InspectorTab) => void
  closeLearnInspectorTab: (tab: LearnInspectorTab) => void
  openOutline: () => void
  closeLearnInspector: () => void
  setChatContentWidth: (w: number) => void
}

const persisted = loadPersistedLayout()

/** 打开浏览器页签所需的布局字段；作用域由调用方按当前表面传入。 */
function browserPaneOpenPatch(
  state: LayoutStoreState,
  isLearnSurface: boolean
): Partial<LayoutStoreState> {
  if (isLearnSurface) {
    return {
      learnInspectorOpen: true,
      learnInspectorTab: 'browser',
      learnInspectorTabs: withTabOpened(state.learnInspectorTabs, 'browser')
    }
  }
  return {
    inspectorOpen: true,
    inspectorTab: 'browser',
    inspectorTabs: withTabOpened(state.inspectorTabs, 'browser'),
    // 计划表面没有页签条，先回标准表面浏览器才可见
    inspectorSurface: 'standard',
    planTarget: null,
    subagentTarget: null,
    statusSessionId: null,
    detailReturnState: null
  }
}

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

  setPinnedSessionOrder: (order) => {
    const deduped = Array.from(new Set(order.filter(Boolean)))
    writeStored('pinnedSessionOrder', JSON.stringify(deduped))
    set({ pinnedSessionOrder: deduped })
  },

  setPinnedProjectOrder: (order) => {
    const deduped = Array.from(new Set(order.filter(Boolean)))
    writeStored('pinnedProjectOrder', JSON.stringify(deduped))
    set({ pinnedProjectOrder: deduped })
  },

  openReview: (target) => {
    persistInspectorTab('review')
    set({
      inspectorOpen: true,
      inspectorTab: 'review',
      inspectorTabs: withTabOpened(get().inspectorTabs, 'review'),
      reviewTarget: target,
      inspectorSurface: 'standard',
      planTarget: null,
      subagentTarget: null,
      statusSessionId: null,
      detailReturnState: null,
      ...USER_OWNS_PANE
    })
  },

  openFiles: () => {
    persistInspectorTab('files')
    set({
      inspectorOpen: true,
      inspectorTab: 'files',
      inspectorTabs: withTabOpened(get().inspectorTabs, 'files'),
      inspectorSurface: 'standard',
      planTarget: null,
      subagentTarget: null,
      statusSessionId: null,
      detailReturnState: null,
      ...USER_OWNS_PANE
    })
  },

  openPlan: (target) => {
    const state = get()
    set({
      inspectorOpen: true,
      inspectorSurface: 'plan',
      planTarget: target,
      subagentTarget: null,
      statusSessionId: null,
      detailReturnState: state.inspectorSurface !== 'standard'
        ? state.detailReturnState
        : { inspectorOpen: state.inspectorOpen, inspectorTab: state.inspectorTab },
      ...USER_OWNS_PANE
    })
  },

  openSubagent: (target) => {
    const state = get()
    set({
      inspectorOpen: true,
      inspectorSurface: 'subagent',
      subagentTarget: target,
      planTarget: null,
      statusSessionId: null,
      detailReturnState: state.inspectorSurface !== 'standard'
        ? state.detailReturnState
        : { inspectorOpen: state.inspectorOpen, inspectorTab: state.inspectorTab },
      ...USER_OWNS_PANE
    })
  },

  openStatus: (sessionId) => {
    const state = get()
    set({
      inspectorOpen: true,
      inspectorSurface: 'status',
      statusSessionId: sessionId,
      planTarget: null,
      subagentTarget: null,
      detailReturnState: state.inspectorSurface !== 'standard'
        ? state.detailReturnState
        : { inspectorOpen: state.inspectorOpen, inspectorTab: state.inspectorTab },
      ...USER_OWNS_PANE
    })
  },

  closeInspector: () => {
    const state = get()
    if (state.inspectorSurface !== 'standard') {
      const restore = state.detailReturnState
      set({
        inspectorOpen: restore?.inspectorOpen ?? false,
        inspectorTab: restore?.inspectorTab ?? state.inspectorTab,
        inspectorSurface: 'standard',
        planTarget: null,
        subagentTarget: null,
        statusSessionId: null,
        detailReturnState: null,
        ...USER_OWNS_PANE
      })
      return
    }
    set({ inspectorOpen: false, ...USER_OWNS_PANE })
  },

  toggleInspector: (tab) => {
    const state = get()
    if (tab === undefined) {
      set({ inspectorOpen: !state.inspectorOpen, ...USER_OWNS_PANE })
      return
    }
    if (state.inspectorOpen && state.inspectorTab === tab) {
      set({ inspectorOpen: false, ...USER_OWNS_PANE })
      return
    }
    persistInspectorTab(tab)
    set({
      inspectorOpen: true,
      inspectorTab: tab,
      inspectorTabs: withTabOpened(state.inspectorTabs, tab),
      ...USER_OWNS_PANE
    })
  },

  setInspectorWidth: (w) => {
    const inspectorWidth = clamp(w, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
    writeStored('inspectorWidth', String(inspectorWidth))
    set({ inspectorWidth })
  },

  /** 打开视图标签并激活；已打开则只切换。 */
  setInspectorTab: (tab) => {
    persistInspectorTab(tab)
    set({ inspectorTab: tab, inspectorTabs: withTabOpened(get().inspectorTabs, tab), ...USER_OWNS_PANE })
  },

  closeInspectorTab: (tab) => {
    const state = get()
    const next = withTabClosed(state.inspectorTabs, state.inspectorTab, tab)
    if (next.active !== state.inspectorTab) persistInspectorTab(next.active)
    set({ inspectorTabs: next.tabs, inspectorTab: next.active, ...USER_OWNS_PANE })
  },

  selectReviewFile: (filePath) => {
    const { reviewTarget } = get()
    if (reviewTarget === null) return
    set({ reviewTarget: { ...reviewTarget, filePath } })
  },

  /** 打开右侧面板并切到浏览器页签；作用域由调用方按当前表面传入。 */
  openBrowserPane: (isLearnSurface) => {
    set({ ...browserPaneOpenPatch(get(), isLearnSurface), ...USER_OWNS_PANE })
  },

  autoOpenBrowserPane: (isLearnSurface) => {
    const state = get()
    // 面板已经在显示浏览器（用户打开或此前已自动打开）：保持现有归属，不重复记录
    if (selectBrowserPaneActive(state, isLearnSurface)) return
    const restore: BrowserAutoOpenRestore = isLearnSurface
      ? {
          scope: 'learn',
          learnInspectorOpen: state.learnInspectorOpen,
          learnInspectorTab: state.learnInspectorTab,
          learnInspectorTabs: state.learnInspectorTabs
        }
      : {
          scope: 'dev',
          inspectorOpen: state.inspectorOpen,
          inspectorTab: state.inspectorTab,
          inspectorTabs: state.inspectorTabs,
          inspectorSurface: state.inspectorSurface,
          planTarget: state.planTarget,
          subagentTarget: state.subagentTarget,
          statusSessionId: state.statusSessionId,
          detailReturnState: state.detailReturnState
        }
    set({ ...browserPaneOpenPatch(state, isLearnSurface), browserAutoOpenRestore: restore })
  },

  releaseAutoOpenedBrowserPane: () => {
    const restore = get().browserAutoOpenRestore
    if (!restore) return
    if (restore.scope === 'learn') {
      set({
        learnInspectorOpen: restore.learnInspectorOpen,
        learnInspectorTab: restore.learnInspectorTab,
        learnInspectorTabs: restore.learnInspectorTabs,
        browserAutoOpenRestore: null
      })
      return
    }
    set({
      inspectorOpen: restore.inspectorOpen,
      inspectorTab: restore.inspectorTab,
      inspectorTabs: restore.inspectorTabs,
      inspectorSurface: restore.inspectorSurface,
      planTarget: restore.planTarget,
      subagentTarget: restore.subagentTarget,
      statusSessionId: restore.statusSessionId,
      detailReturnState: restore.detailReturnState,
      browserAutoOpenRestore: null
    })
  },

  /** 浏览器页签已激活时，快捷键再次触发会收起面板。 */
  toggleBrowserPane: (isLearnSurface) => {
    const state = get()
    const active = selectBrowserPaneActive(state, isLearnSurface)
    if (active) {
      if (isLearnSurface) set({ learnInspectorOpen: false, ...USER_OWNS_PANE })
      else set({ inspectorOpen: false, ...USER_OWNS_PANE })
      return
    }
    get().openBrowserPane(isLearnSurface)
  },

  toggleLearnInspector: () => {
    const learnInspectorOpen = !get().learnInspectorOpen
    writeStored('learnInspectorOpen', String(learnInspectorOpen))
    set({ learnInspectorOpen, ...USER_OWNS_PANE })
  },

  /** 打开学习视图标签并激活；已打开则只切换。 */
  setLearnInspectorTab: (learnInspectorTab) => {
    persistLearnInspectorTab(learnInspectorTab)
    set({
      learnInspectorTab,
      learnInspectorTabs: withTabOpened(get().learnInspectorTabs, learnInspectorTab),
      ...USER_OWNS_PANE
    })
  },

  closeLearnInspectorTab: (tab) => {
    const state = get()
    const next = withTabClosed(state.learnInspectorTabs, state.learnInspectorTab, tab)
    if (next.active !== state.learnInspectorTab) persistLearnInspectorTab(next.active)
    set({ learnInspectorTabs: next.tabs, learnInspectorTab: next.active, ...USER_OWNS_PANE })
  },

  openOutline: () => {
    writeStored('learnInspectorOpen', 'true')
    persistLearnInspectorTab('outline')
    set({
      learnInspectorOpen: true,
      learnInspectorTab: 'outline',
      learnInspectorTabs: withTabOpened(get().learnInspectorTabs, 'outline'),
      ...USER_OWNS_PANE
    })
  },

  closeLearnInspector: () => {
    writeStored('learnInspectorOpen', 'false')
    set({ learnInspectorOpen: false, ...USER_OWNS_PANE })
  },

  setChatContentWidth: (w) => {
    const chatContentWidth = clamp(w, CHAT_CONTENT_WIDTH_MIN, CHAT_CONTENT_WIDTH_MAX)
    writeStored('chatContentWidth', String(chatContentWidth))
    set({ chatContentWidth })
  }
}))

/** 当前表面的面板是否打开：学习会话读学习那组状态，其余读开发那组。 */
export function selectInspectorOpenForSurface(state: LayoutStoreState, isLearnSurface: boolean): boolean {
  return isLearnSurface ? state.learnInspectorOpen : state.inspectorOpen
}

/**
 * 当前表面的激活视图键；没有打开任何标签（面板首页）时为 null。
 * inspectorTab / learnInspectorTab 只记录最近激活的页签，是否仍打开以标签列表为准；
 * 记录的页签不在列表里时退回第一个标签，保证有标签就有一个被显示。
 */
export function selectActiveInspectorTab(state: LayoutStoreState, isLearnSurface: boolean): InspectorViewKey | null {
  const tabs: readonly InspectorViewKey[] = isLearnSurface ? state.learnInspectorTabs : state.inspectorTabs
  const active: InspectorViewKey = isLearnSurface ? state.learnInspectorTab : state.inspectorTab
  return tabs.includes(active) ? active : (tabs[0] ?? null)
}

/** 浏览器页签是否为当前表面的激活页签（guest 层据此决定 webview 可见性）。 */
export function selectBrowserPaneActive(state: LayoutStoreState, isLearnSurface: boolean): boolean {
  if (selectActiveInspectorTab(state, isLearnSurface) !== 'browser') return false
  return isLearnSurface
    ? state.learnInspectorOpen
    : state.inspectorOpen && state.inspectorSurface === 'standard'
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
        'learnInspectorTab',
        'chatContentWidth',
        'pinnedSessionOrder',
        'pinnedProjectOrder'
      ]) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      }
    } catch {
      // ignore
    }
  }
  useLayoutStore.setState({ ...DEFAULTS })
}
