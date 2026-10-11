/**
 * SettingsModal — 全屏设置壳层
 * 左侧搜索 + 分组导航（偏好 / 能力 / 系统）+ 右侧浮动内容板；
 * 内容板顶部承载当前板块的标题与描述，各面板不再自带页头。
 */
import React, { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { usePanelPresence } from '../../hooks/usePanelPresence'
import { afterStartupComplete } from '../../installWindowStartupSignal'
import { WindowControls } from '../../components/ContentTopBar'
import { rulesI18n, skillsI18n, subagentsI18n } from '../skills/i18n'
import {
  SettingsIcon,
  CpuIcon,
  GitForkIcon,
  BrainIcon,
  ScrollIcon,
  PuzzleIcon,
  CodeIndexIcon,
  SearchIcon,
  ShieldCheckIcon,
  DatabaseIcon,
  InfoIcon,
  ArrowLeftIcon
} from '../../components/Icons'
// 11 个设置面板改由下方 SETTINGS_PANELS 的 lazy() 按需加载，不在此静态 import
import './SettingsModal.css'

const NAV_STORAGE_KEY = 'nova-settings-nav'

export type SettingsSection =
  | 'general'
  | 'llm'
  | 'subagents'
  | 'memory'
  | 'rules'
  | 'skills'
  | 'codeindex'
  | 'websearch'
  | 'permissions'
  | 'storage'
  | 'diagnostics'

const SECTION_IDS: SettingsSection[] = [
  'general',
  'llm',
  'subagents',
  'memory',
  'rules',
  'skills',
  'codeindex',
  'websearch',
  'permissions',
  'storage',
  'diagnostics'
]

interface NavItemMeta {
  id: SettingsSection
  label: string
  description: string
  /** 侧栏搜索额外匹配的词（英文名、页内设置项） */
  keywords: string
  icon: React.ReactNode
  badge?: string
}

interface NavGroupMeta {
  title: string
  items: NavItemMeta[]
}

const NAV_GROUPS: NavGroupMeta[] = [
  {
    title: '偏好',
    items: [
      {
        id: 'general',
        label: '通用',
        description: '应用级偏好设置，重启后仍然生效。',
        keywords: 'general 运行模式 权限模式 工作区 工具调用 主题 深色 浅色 theme shell 终端 通知 更新 版本',
        icon: <SettingsIcon size={16} />
      }
    ]
  },
  {
    title: '能力',
    items: [
      {
        id: 'llm',
        label: '模型',
        description: '按服务商管理 API Key 与模型，可在对话框底部快速切换。',
        keywords: 'model llm provider 连接',
        icon: <CpuIcon size={16} />
      },
      {
        id: 'subagents',
        label: '子 Agent',
        description: subagentsI18n.panelDesc,
        keywords: 'subagent 子代理',
        icon: <GitForkIcon size={16} />
      },
      {
        id: 'memory',
        label: '记忆',
        description: '查看与编辑当前工作区的跨会话记忆文件（按工作区哈希隔离）。',
        keywords: 'memory 自动学习',
        icon: <BrainIcon size={16} />
      },
      {
        id: 'rules',
        label: '规则',
        description: rulesI18n.panelDesc,
        keywords: 'rules',
        icon: <ScrollIcon size={16} />
      },
      {
        id: 'skills',
        label: '技能',
        description: skillsI18n.panelDesc,
        keywords: 'skills 第三方技能',
        icon: <PuzzleIcon size={16} />
      },
      {
        id: 'codeindex',
        label: '代码索引',
        description: '管理当前工作区的本地代码结构索引、运行状态与重建操作。',
        keywords: 'code index',
        icon: <CodeIndexIcon size={16} />
      },
      {
        id: 'websearch',
        label: '联网搜索',
        description:
          '无需配置 API Key 也可通过 Bing / DuckDuckGo 联网搜索。填写 Tavily API Key 可在爬虫失败时作为质量增强兜底。',
        keywords: 'web search',
        icon: <SearchIcon size={16} />,
        badge: 'Beta'
      }
    ]
  },
  {
    title: '系统',
    items: [
      {
        id: 'permissions',
        label: '权限与能力',
        description: '管理工具调用的持久化授权规则。项目级规则只对当前打开的项目生效。',
        keywords: 'permissions',
        icon: <ShieldCheckIcon size={16} />
      },
      {
        id: 'storage',
        label: '数据与存储',
        description: '查看会话磁盘占用，并清理 checkpoint 快照或彻底删除不再需要的会话。',
        keywords: 'storage',
        icon: <DatabaseIcon size={16} />
      },
      {
        id: 'diagnostics',
        label: '诊断',
        description: '导出脱敏诊断包（日志与系统信息，不含密钥与消息内容），反馈问题时附上。',
        keywords: 'diagnostics',
        icon: <InfoIcon size={16} />
      }
    ]
  }
]

function findNavMeta(id: SettingsSection): NavItemMeta {
  for (const group of NAV_GROUPS) {
    const hit = group.items.find(item => item.id === id)
    if (hit) return hit
  }
  return NAV_GROUPS[0].items[0]
}

function readStoredSection(): SettingsSection {
  try {
    const raw = sessionStorage.getItem(NAV_STORAGE_KEY)
    if (raw && (SECTION_IDS as string[]).includes(raw)) {
      return raw as SettingsSection
    }
  } catch {
    // sessionStorage 不可用时忽略
  }
  return 'general'
}

function matchesQuery(item: NavItemMeta, query: string): boolean {
  return `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(query)
}

interface SettingsPanelModule {
  Panel: React.FC
  preload: () => Promise<React.FC>
}

/**
 * 可预取的懒加载面板：面板代码不进首屏包；预取完成后挂载直接渲染真身，不再闪一帧 Suspense 骨架。
 * 每次挂载只选定一次组件类型，加载完成后也不会从懒包装切到真身而重挂载（会丢状态、重拉数据）。
 */
function lazyPanel(load: () => Promise<React.FC>): SettingsPanelModule {
  let loaded: React.FC | null = null
  let pending: Promise<React.FC> | null = null
  const preload = (): Promise<React.FC> => {
    pending ??= load().then(component => {
      loaded = component
      return component
    })
    return pending
  }
  const LazyPanel = lazy(() => preload().then(component => ({ default: component })))
  const Panel: React.FC = () => {
    const [Component] = useState<React.FC | typeof LazyPanel>(() => loaded ?? LazyPanel)
    return <Component />
  }
  return { Panel, preload }
}

const SETTINGS_PANELS: Record<SettingsSection, SettingsPanelModule> = {
  general: lazyPanel(() => import('./GeneralSettingsPanel').then(m => m.GeneralSettingsPanel)),
  llm: lazyPanel(() => import('./LlmSettingsPanel').then(m => m.LlmSettingsPanel)),
  subagents: lazyPanel(() => import('./SubagentsSettingsPanel').then(m => m.SubagentsSettingsPanel)),
  memory: lazyPanel(() => import('./MemorySettingsPanel').then(m => m.MemorySettingsPanel)),
  rules: lazyPanel(() => import('./RulesSettingsPanel').then(m => m.RulesSettingsPanel)),
  skills: lazyPanel(() => import('./SkillsSettingsPanel').then(m => m.SkillsSettingsPanel)),
  codeindex: lazyPanel(() => import('./CodeIndexSettingsPanel').then(m => m.CodeIndexSettingsPanel)),
  websearch: lazyPanel(() => import('./WebSearchSettingsPanel').then(m => m.WebSearchSettingsPanel)),
  permissions: lazyPanel(() => import('./PermissionsSettingsPanel').then(m => m.PermissionsSettingsPanel)),
  storage: lazyPanel(() => import('./StorageSettingsPanel').then(m => m.StorageSettingsPanel)),
  diagnostics: lazyPanel(() => import('./DiagnosticsSettingsPanel').then(m => m.DiagnosticsSettingsPanel))
}

/** 预取失败不在此处理：渲染该面板时 lazy 会抛出同一个错误 */
function preloadPanel(id: SettingsSection): void {
  SETTINGS_PANELS[id].preload().catch(() => undefined)
}

export const SettingsModal: React.FC = () => {
  const isOpen = useSettingsStore(state => state.isConfigModalOpen)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  const shellRef = useRef<HTMLDialogElement>(null)
  // 关闭后保留到壳层退场动画播完；store 立即关闭，不让动画时长进入业务状态
  const present = usePanelPresence({ open: isOpen, shellRef })

  // 启动揭幕后空闲时预取上次停留分区的面板代码，首次打开设置不必现场下载与编译
  useEffect(() => {
    if (typeof window.requestIdleCallback !== 'function') return
    let handle: number | undefined
    const cancelWait = afterStartupComplete(() => {
      handle = window.requestIdleCallback(() => preloadPanel(readStoredSection()))
    })
    return () => {
      cancelWait()
      if (handle !== undefined) window.cancelIdleCallback(handle)
    }
  }, [])

  if (!isOpen && !present) return null
  return (
    <SettingsModalSession
      shellRef={shellRef}
      closing={!isOpen}
      onClose={() => setConfigModalOpen(false)}
    />
  )
}

const SettingsModalSession: React.FC<{
  shellRef: RefObject<HTMLDialogElement | null>
  closing: boolean
  onClose: () => void
}> = ({ shellRef, closing, onClose }) => {
  const [section, setSection] = useState<SettingsSection>(readStoredSection)
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([readStoredSection()]))
  const [enterActive, setEnterActive] = useState(true)
  const [query, setQuery] = useState('')
  const firstSectionRef = useRef(true)
  const navRefs = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({})
  const escapeOwnedByNested = useRef(false)

  // 子 Dialog 的 Esc 会冒泡到壳层，但冒泡前它的关闭状态可能已提交并卸载；
  // 因此在捕获阶段（子 Dialog 仍在 DOM 中）判定本次 Esc 的归属。
  useEffect(() => {
    const dialog = shellRef.current
    if (!dialog) return
    let resetTimer = 0
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      escapeOwnedByNested.current = dialog.querySelector('dialog[open]') !== null
      window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        escapeOwnedByNested.current = false
      }, 0)
    }
    dialog.addEventListener('keydown', claimEscape, true)
    return () => {
      window.clearTimeout(resetTimer)
      dialog.removeEventListener('keydown', claimEscape, true)
    }
  }, [shellRef])

  useEffect(() => {
    if (firstSectionRef.current) {
      firstSectionRef.current = false
      return
    }
    setEnterActive(false)
    const frame = requestAnimationFrame(() => setEnterActive(true))
    return () => cancelAnimationFrame(frame)
  }, [section])

  const selectSection = (id: SettingsSection) => {
    setSection(id)
    setVisited(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    try {
      sessionStorage.setItem(NAV_STORAGE_KEY, id)
    } catch {
      // 忽略
    }
    navRefs.current[id]?.focus()
  }

  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = normalizedQuery
    ? NAV_GROUPS
        .map(group => ({ ...group, items: group.items.filter(item => matchesQuery(item, normalizedQuery)) }))
        .filter(group => group.items.length > 0)
    : NAV_GROUPS
  const visibleItems = visibleGroups.flatMap(group => group.items)
  // 当前分区被搜索过滤掉时，把 Tab 落点交给第一个可见项，保证导航仍可键盘进入
  const tabStopId = visibleItems.some(item => item.id === section) ? section : visibleItems[0]?.id

  const handleNavKeyDown = (e: React.KeyboardEvent, currentId: SettingsSection) => {
    const currentIndex = visibleItems.findIndex(item => item.id === currentId)
    if (currentIndex === -1) return

    let targetItem: NavItemMeta | undefined
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      targetItem = visibleItems[(currentIndex + 1) % visibleItems.length]
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      targetItem = visibleItems[(currentIndex - 1 + visibleItems.length) % visibleItems.length]
    } else if (e.key === 'Home') {
      e.preventDefault()
      targetItem = visibleItems[0]
    } else if (e.key === 'End') {
      e.preventDefault()
      targetItem = visibleItems[visibleItems.length - 1]
    }

    if (targetItem) {
      selectSection(targetItem.id)
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const first = visibleItems[0]
    if (!first) return
    if (e.key === 'Enter') {
      e.preventDefault()
      selectSection(first.id)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      navRefs.current[tabStopId ?? first.id]?.focus()
    }
  }

  const active = findNavMeta(section)

  return (
    <Dialog
      ref={shellRef}
      isOpen
      variant="fullscreen"
      onOpenChange={open => {
        if (!open && !escapeOwnedByNested.current) onClose()
      }}
      padding={0}
      className={closing ? 'settings-shell settings-shell--closing' : 'settings-shell'}
      aria-label="设置"
    >
      <header className="settings-shell__titlebar">
        <div className="settings-shell__titlebar-drag-area" aria-hidden="true" />
        <span className="settings-shell__titlebar-label">设置</span>
        <div className="settings-shell__titlebar-controls">
          <WindowControls />
        </div>
      </header>
      <div className="settings-shell__layout">
        <aside className="settings-shell__sidebar">
          <button
            type="button"
            className="settings-shell__back"
            onClick={onClose}
            aria-label="返回应用"
          >
            <ArrowLeftIcon size={16} className="settings-shell__back-icon" />
            <span className="settings-shell__back-label">返回应用</span>
          </button>

          <label className="settings-search">
            <SearchIcon size={14} className="settings-search__icon" aria-hidden="true" />
            <input
              type="search"
              className="settings-search__input"
              placeholder="搜索设置…"
              aria-label="搜索设置"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </label>

          <nav className="settings-nav" aria-label="设置分区导航" role="tablist">
            {visibleItems.length === 0 && (
              <p className="settings-nav__empty">没有匹配的设置</p>
            )}
            {visibleGroups.map(group => (
              <div key={group.title} className="settings-nav__group">
                <div className="settings-nav__group-title">{group.title}</div>
                <div className="settings-nav__group-items">
                  {group.items.map(item => {
                    const isSelected = section === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        tabIndex={item.id === tabStopId ? 0 : -1}
                        className={`settings-nav__item ${isSelected ? 'settings-nav__item--selected' : ''}`}
                        onClick={() => selectSection(item.id)}
                        onKeyDown={e => handleNavKeyDown(e, item.id)}
                        onPointerEnter={() => preloadPanel(item.id)}
                        onFocus={() => preloadPanel(item.id)}
                        ref={el => {
                          navRefs.current[item.id] = el
                        }}
                      >
                        <span className="settings-nav__item-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span className="settings-nav__item-label">{item.label}</span>
                        {item.badge && (
                          <span className="settings-nav__item-badge">{item.badge}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <main className="settings-shell__pane" aria-label={active.label}>
          <header className="settings-shell__header">
            <h2 className="settings-shell__title">{active.label}</h2>
            <p className="settings-shell__desc">{active.description}</p>
          </header>
          <div className="settings-shell__content">
            {SECTION_IDS.map(id => {
              if (!visited.has(id)) return null
              const { Panel } = SETTINGS_PANELS[id]
              const isActive = section === id
              return (
                <div
                  key={id}
                  className={
                    isActive && enterActive
                      ? 'settings-shell__tab settings-shell__tab--enter'
                      : 'settings-shell__tab'
                  }
                  hidden={!isActive}
                  role="tabpanel"
                  aria-label={findNavMeta(id).label}
                >
                  <Suspense
                    fallback={
                      <div className="settings-shell__panel-loading" aria-hidden>
                        <div className="settings-shell__panel-loading-row" />
                        <div className="settings-shell__panel-loading-row" />
                        <div className="settings-shell__panel-loading-row" />
                      </div>
                    }
                  >
                    <Panel />
                  </Suspense>
                </div>
              )
            })}
          </div>
        </main>
      </div>
    </Dialog>
  )
}

