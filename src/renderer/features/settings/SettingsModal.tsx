/**
 * SettingsModal — 全屏设置壳层
 * 左侧分组导航（偏好 / 能力 / 系统）+ 右侧浮动内容板；
 * 内容板顶部承载当前板块的标题与描述，各面板不再自带页头。
 */
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { useSettingsStore } from '../../stores/useSettingsStore'
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
        icon: <CpuIcon size={16} />
      },
      {
        id: 'subagents',
        label: '子 Agent',
        description: subagentsI18n.panelDesc,
        icon: <GitForkIcon size={16} />
      },
      {
        id: 'memory',
        label: '记忆',
        description: '查看与编辑当前工作区的跨会话记忆文件（按工作区哈希隔离）。',
        icon: <BrainIcon size={16} />
      },
      {
        id: 'rules',
        label: '规则',
        description: rulesI18n.panelDesc,
        icon: <ScrollIcon size={16} />
      },
      {
        id: 'skills',
        label: '技能',
        description: skillsI18n.panelDesc,
        icon: <PuzzleIcon size={16} />
      },
      {
        id: 'codeindex',
        label: '代码索引',
        description: '管理当前工作区的本地代码结构索引、运行状态与重建操作。',
        icon: <CodeIndexIcon size={16} />
      },
      {
        id: 'websearch',
        label: '联网搜索',
        description:
          '无需配置 API Key 也可通过 Bing / DuckDuckGo 联网搜索。填写 Tavily API Key 可在爬虫失败时作为质量增强兜底。',
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
        icon: <ShieldCheckIcon size={16} />
      },
      {
        id: 'storage',
        label: '数据与存储',
        description: '查看会话磁盘占用，并清理 checkpoint 快照或彻底删除不再需要的会话。',
        icon: <DatabaseIcon size={16} />
      },
      {
        id: 'diagnostics',
        label: '诊断',
        description: '导出脱敏诊断包（日志与系统信息，不含密钥与消息内容），反馈问题时附上。',
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

/**
 * 设置面板映射表：全部走 lazy，使这些面板不进入首屏包。
 *
 * 面板本身只在打开对应 section 时才渲染（见下方 visited 判断），
 * 但静态 import 会让它们的代码在启动时就被下载。改为 lazy 后，
 * 首屏不加载，点开某个 section 时才拉对应 chunk。
 */
const SETTINGS_PANELS: Record<SettingsSection, React.FC> = {
  general: lazy(() => import('./GeneralSettingsPanel').then(m => ({ default: m.GeneralSettingsPanel }))),
  llm: lazy(() => import('./LlmSettingsPanel').then(m => ({ default: m.LlmSettingsPanel }))),
  subagents: lazy(() => import('./SubagentsSettingsPanel').then(m => ({ default: m.SubagentsSettingsPanel }))),
  memory: lazy(() => import('./MemorySettingsPanel').then(m => ({ default: m.MemorySettingsPanel }))),
  rules: lazy(() => import('./RulesSettingsPanel').then(m => ({ default: m.RulesSettingsPanel }))),
  skills: lazy(() => import('./SkillsSettingsPanel').then(m => ({ default: m.SkillsSettingsPanel }))),
  codeindex: lazy(() => import('./CodeIndexSettingsPanel').then(m => ({ default: m.CodeIndexSettingsPanel }))),
  websearch: lazy(() => import('./WebSearchSettingsPanel').then(m => ({ default: m.WebSearchSettingsPanel }))),
  permissions: lazy(() => import('./PermissionsSettingsPanel').then(m => ({ default: m.PermissionsSettingsPanel }))),
  storage: lazy(() => import('./StorageSettingsPanel').then(m => ({ default: m.StorageSettingsPanel }))),
  diagnostics: lazy(() => import('./DiagnosticsSettingsPanel').then(m => ({ default: m.DiagnosticsSettingsPanel })))
}

export const SettingsModal: React.FC = () => {
  const isOpen = useSettingsStore(state => state.isConfigModalOpen)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)
  if (!isOpen) return null
  return <SettingsModalSession onClose={() => setConfigModalOpen(false)} />
}

const SettingsModalSession: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [section, setSection] = useState<SettingsSection>(readStoredSection)
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set([readStoredSection()]))
  const [enterActive, setEnterActive] = useState(true)
  const firstSectionRef = useRef(true)
  const navRefs = useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({})
  const shellRef = useRef<HTMLDialogElement>(null)
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
  }, [])

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

  const handleNavKeyDown = (e: React.KeyboardEvent, currentId: SettingsSection) => {
    const allItems = NAV_GROUPS.flatMap(g => g.items)
    const currentIndex = allItems.findIndex(item => item.id === currentId)
    if (currentIndex === -1) return

    let targetItem: NavItemMeta | undefined
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      targetItem = allItems[(currentIndex + 1) % allItems.length]
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      targetItem = allItems[(currentIndex - 1 + allItems.length) % allItems.length]
    } else if (e.key === 'Home') {
      e.preventDefault()
      targetItem = allItems[0]
    } else if (e.key === 'End') {
      e.preventDefault()
      targetItem = allItems[allItems.length - 1]
    }

    if (targetItem) {
      selectSection(targetItem.id)
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
      className="settings-shell"
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

          <nav className="settings-nav" aria-label="设置分区导航" role="tablist">
            {NAV_GROUPS.map(group => (
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
                        tabIndex={isSelected ? 0 : -1}
                        className={`settings-nav__item ${isSelected ? 'settings-nav__item--selected' : ''}`}
                        onClick={() => selectSection(item.id)}
                        onKeyDown={e => handleNavKeyDown(e, item.id)}
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
              const Panel = SETTINGS_PANELS[id]
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

