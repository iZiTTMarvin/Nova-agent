import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetLayoutStoreForTests,
  selectBrowserPaneActive,
  useLayoutStore
} from '../../../src/renderer/stores/useLayoutStore'

/** vitest 默认 node 环境无 localStorage，提供最小实现以覆盖持久化 */
function installLocalStorageMock(): void {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, String(value))
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true
  })
}

describe('useLayoutStore', () => {
  beforeEach(() => {
    installLocalStorageMock()
    resetLayoutStoreForTests()
  })

  it('初始默认值', () => {
    const s = useLayoutStore.getState()
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.sidebarWidth).toBe(264)
    expect(s.inspectorOpen).toBe(false)
    expect(s.inspectorTab).toBe('review')
    expect(s.inspectorWidth).toBe(420)
    expect(s.reviewTarget).toBeNull()
    expect(s.inspectorSurface).toBe('standard')
    expect(s.planTarget).toBeNull()
  })

  it('计划视图复用 Inspector 并在关闭后恢复此前 surface', () => {
    useLayoutStore.getState().openFiles()
    useLayoutStore.getState().openPlan({
      sessionId: 's1',
      messageId: 'm1',
      toolCallId: 'p1'
    })
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorSurface: 'plan',
      inspectorTab: 'files',
      planTarget: { sessionId: 's1', messageId: 'm1', toolCallId: 'p1' }
    })

    useLayoutStore.getState().closeInspector()
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorSurface: 'standard',
      inspectorTab: 'files',
      planTarget: null
    })
  })

  it('从关闭状态打开计划，关闭计划后仍回到关闭状态', () => {
    useLayoutStore.getState().openPlan({ sessionId: 's1', messageId: 'm1', toolCallId: 'p1' })
    useLayoutStore.getState().closeInspector()
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: false,
      inspectorSurface: 'standard',
      planTarget: null
    })
  })

  it('openReview / openFiles / closeInspector', () => {
    useLayoutStore.getState().openReview({ messageId: 'm1', filePath: 'a.ts' })
    let s = useLayoutStore.getState()
    expect(s.inspectorOpen).toBe(true)
    expect(s.inspectorTab).toBe('review')
    expect(s.reviewTarget).toEqual({ messageId: 'm1', filePath: 'a.ts' })

    useLayoutStore.getState().openFiles()
    s = useLayoutStore.getState()
    expect(s.inspectorOpen).toBe(true)
    expect(s.inspectorTab).toBe('files')
    // openFiles 不清除 reviewTarget，便于切回审阅
    expect(s.reviewTarget).toEqual({ messageId: 'm1', filePath: 'a.ts' })

    useLayoutStore.getState().closeInspector()
    s = useLayoutStore.getState()
    expect(s.inspectorOpen).toBe(false)
    expect(s.reviewTarget).toEqual({ messageId: 'm1', filePath: 'a.ts' })
  })

  it('toggleInspector：无 tab 开合；同 tab 再点关闭；异 tab 打开并切换', () => {
    useLayoutStore.getState().toggleInspector()
    expect(useLayoutStore.getState().inspectorOpen).toBe(true)

    useLayoutStore.getState().toggleInspector()
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)

    useLayoutStore.getState().toggleInspector('files')
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'files'
    })

    useLayoutStore.getState().toggleInspector('files')
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)

    useLayoutStore.getState().toggleInspector('review')
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'review'
    })

    useLayoutStore.getState().toggleInspector('files')
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'files'
    })
  })

  it('宽度 clamp', () => {
    useLayoutStore.getState().setSidebarWidth(100)
    expect(useLayoutStore.getState().sidebarWidth).toBe(200)
    useLayoutStore.getState().setSidebarWidth(999)
    expect(useLayoutStore.getState().sidebarWidth).toBe(400)

    useLayoutStore.getState().setInspectorWidth(100)
    expect(useLayoutStore.getState().inspectorWidth).toBe(320)
    useLayoutStore.getState().setInspectorWidth(999)
    expect(useLayoutStore.getState().inspectorWidth).toBe(720)
  })

  it('selectReviewFile：有 target 时更新 filePath；null 时 no-op', () => {
    useLayoutStore.getState().selectReviewFile('x.ts')
    expect(useLayoutStore.getState().reviewTarget).toBeNull()

    useLayoutStore.getState().openReview({ messageId: 'm2' })
    useLayoutStore.getState().selectReviewFile('src/b.ts')
    expect(useLayoutStore.getState().reviewTarget).toEqual({
      messageId: 'm2',
      filePath: 'src/b.ts'
    })
  })

  it('localStorage 持久化往返（不含 inspectorOpen / reviewTarget）', () => {
    useLayoutStore.getState().toggleSidebar()
    useLayoutStore.getState().setSidebarWidth(300)
    useLayoutStore.getState().setInspectorWidth(500)
    useLayoutStore.getState().openReview({ messageId: 'm3' })
    // openReview 会写入 tab=review；最后再切到 files 验证 setter 持久化
    useLayoutStore.getState().setInspectorTab('files')

    expect(localStorage.getItem('nova.layout.sidebarCollapsed')).toBe('true')
    expect(localStorage.getItem('nova.layout.sidebarWidth')).toBe('300')
    expect(localStorage.getItem('nova.layout.inspectorWidth')).toBe('500')
    expect(localStorage.getItem('nova.layout.inspectorTab')).toBe('files')
    expect(localStorage.getItem('nova.layout.inspectorOpen')).toBeNull()
    expect(localStorage.getItem('nova.layout.reviewTarget')).toBeNull()

    // 模拟重启：仅恢复可持久化字段；open / reviewTarget 回到默认
    useLayoutStore.setState({
      sidebarCollapsed: localStorage.getItem('nova.layout.sidebarCollapsed') === 'true',
      sidebarWidth: Number(localStorage.getItem('nova.layout.sidebarWidth')),
      inspectorWidth: Number(localStorage.getItem('nova.layout.inspectorWidth')),
      inspectorTab: localStorage.getItem('nova.layout.inspectorTab') as 'files',
      inspectorOpen: false,
      reviewTarget: null
    })

    const s = useLayoutStore.getState()
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.sidebarWidth).toBe(300)
    expect(s.inspectorWidth).toBe(500)
    expect(s.inspectorTab).toBe('files')
    expect(s.inspectorOpen).toBe(false)
    expect(s.reviewTarget).toBeNull()
  })

  it('浏览器页签：打开切页签不持久化，计划表面先回标准，再点收起面板', () => {
    expect(useLayoutStore.getState().inspectorWidth).toBe(420)
    useLayoutStore.getState().openBrowserPane(false)
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'browser',
      inspectorWidth: 420
    })
    // browser 页签不写持久化：重启不自动回到浏览器
    expect(localStorage.getItem('nova.layout.inspectorTab')).toBeNull()

    // 计划表面没有页签条，打开浏览器先回标准表面
    useLayoutStore.getState().setInspectorTab('files')
    useLayoutStore.getState().openPlan({ sessionId: 's1', messageId: 'm1', toolCallId: 'p1' })
    useLayoutStore.getState().openBrowserPane(false)
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'browser',
      inspectorSurface: 'standard',
      planTarget: null
    })

    useLayoutStore.getState().toggleBrowserPane(false)
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    useLayoutStore.getState().toggleBrowserPane(false)
    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorTab: 'browser'
    })

    // 学习表面读写自己那组状态
    useLayoutStore.getState().openBrowserPane(true)
    expect(useLayoutStore.getState()).toMatchObject({
      learnInspectorOpen: true,
      learnInspectorTab: 'browser',
      inspectorTab: 'browser'
    })
    useLayoutStore.getState().toggleBrowserPane(true)
    expect(useLayoutStore.getState().learnInspectorOpen).toBe(false)
  })

  it('视图标签：同一视图只开一个；关闭激活标签切到邻近标签；关掉浏览器标签后网页立即隐藏', () => {
    const layout = useLayoutStore.getState()
    layout.setInspectorTab('files')
    layout.setInspectorTab('review')
    layout.openBrowserPane(false)
    layout.setInspectorTab('files')
    expect(useLayoutStore.getState().inspectorTabs).toEqual(['files', 'review', 'browser'])
    expect(useLayoutStore.getState().inspectorTab).toBe('files')

    // 关闭非激活标签不改变激活项
    useLayoutStore.getState().closeInspectorTab('review')
    expect(useLayoutStore.getState()).toMatchObject({ inspectorTabs: ['files', 'browser'], inspectorTab: 'files' })

    // 关闭激活标签：原位置的右邻居接任，并写入持久化
    useLayoutStore.getState().closeInspectorTab('files')
    expect(useLayoutStore.getState()).toMatchObject({ inspectorTabs: ['browser'], inspectorTab: 'browser' })
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)

    // 最后一个标签关闭：回到没有标签的首页，浏览器不再算作激活
    useLayoutStore.getState().closeInspectorTab('browser')
    expect(useLayoutStore.getState().inspectorTabs).toEqual([])
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(false)
  })

  it('学习表面的标签与开发表面互不影响', () => {
    useLayoutStore.getState().openOutline()
    useLayoutStore.getState().setLearnInspectorTab('files')
    expect(useLayoutStore.getState()).toMatchObject({
      learnInspectorTabs: ['outline', 'files'],
      inspectorTabs: []
    })
    useLayoutStore.getState().closeLearnInspectorTab('files')
    expect(useLayoutStore.getState()).toMatchObject({
      learnInspectorTabs: ['outline'],
      learnInspectorTab: 'outline'
    })
  })

  it('浏览器切至计划时隐藏网页，关闭计划或快捷键返回后恢复', () => {
    const layout = useLayoutStore.getState()
    layout.openBrowserPane(false)
    const target = { sessionId: 's1', messageId: 'm1', toolCallId: 'plan' }
    layout.openPlan(target)
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(false)
    layout.closeInspector()
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    layout.openPlan(target)
    layout.toggleBrowserPane(false)
    expect(selectBrowserPaneActive(useLayoutStore.getState(), false)).toBe(true)
    expect(useLayoutStore.getState().planTarget).toBeNull()
  })
})
