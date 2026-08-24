import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetLayoutStoreForTests,
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
    expect(useLayoutStore.getState().inspectorWidth).toBe(640)
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
})
