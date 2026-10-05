/**
 * WorkspaceChip — Composer 工作区 chip：当前文件夹名 + 搜索/切换/打开文件夹/默认工作区菜单。
 *
 * 选择工作区 = 在目标目录创建新会话（照 ZCode「切项目开新草稿」语义）；
 * 默认工作区从项目列表排除，由底部固定入口承载。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Popover } from '@astryxdesign/core/Popover'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  SearchIcon
} from '../../components/Icons'
import {
  filterWorkspaceProjects,
  listWorkspaceProjects,
  workspaceLabel
} from './workspaceDisplay'
import './composerContext.css'

export const WorkspaceChip: React.FC = () => {
  const currentProjectPath = useWorkspaceStore(state => state.currentProjectPath)
  const defaultWorkspacePath = useWorkspaceStore(state => state.defaultWorkspacePath)
  const sessions = useWorkspaceStore(state => state.availableSessions)
  const selectProject = useWorkspaceStore(state => state.selectProject)
  const selectDefaultWorkspace = useWorkspaceStore(state => state.selectDefaultWorkspace)

  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const projects = useMemo(
    () => listWorkspaceProjects(sessions, defaultWorkspacePath),
    [sessions, defaultWorkspacePath]
  )
  const visibleProjects = useMemo(
    () => filterWorkspaceProjects(projects, searchQuery),
    [projects, searchQuery]
  )

  const isDefaultWorkspace = !!currentProjectPath && currentProjectPath === defaultWorkspacePath
  const label = currentProjectPath ? workspaceLabel(currentProjectPath, defaultWorkspacePath) : '选择工作区'

  useEffect(() => {
    if (!open) return
    setSearchQuery('')
    setError(null)
  }, [open])

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      label="切换工作区"
      placement="above"
      width={288}
      isOpen={open}
      onOpenChange={setOpen}
      content={
        <div className="composer-context-menu" data-testid="composer-workspace-menu">
          <div className="composer-context-menu__search">
            <SearchIcon size={14} />
            <input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="搜索工作区"
              aria-label="搜索工作区"
            />
          </div>

          <div className="composer-context-menu__list" role="listbox" aria-label="已打开的工作区">
            {visibleProjects.length === 0 ? (
              <div className="composer-context-menu__empty">
                {projects.length === 0 ? '还没有其他工作区' : '没有匹配的工作区'}
              </div>
            ) : null}
            {visibleProjects.map(project => {
              const isCurrent = project.path === currentProjectPath
              return (
                <button
                  key={project.path}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-workspace-current={isCurrent ? 'true' : undefined}
                  className="composer-context-menu__item"
                  disabled={busy}
                  title={project.path}
                  onClick={() => void runAction(() => selectProject(project.path))}
                >
                  <FolderIcon size={14} className="composer-context-menu__item-icon" />
                  <span className="composer-context-menu__item-body">
                    <span className="composer-context-menu__item-title">
                      {workspaceLabel(project.path, defaultWorkspacePath)}
                    </span>
                  </span>
                  {isCurrent ? <CheckIcon size={14} className="composer-context-menu__item-check" /> : null}
                </button>
              )
            })}
          </div>

          {error ? (
            <div className="composer-context-menu__error" role="alert">
              <div className="composer-context-menu__error-title">{error}</div>
            </div>
          ) : null}

          <div className="composer-context-menu__footer">
            <button
              type="button"
              className="composer-context-menu__action"
              disabled={busy}
              onClick={() => void runAction(() => selectProject())}
            >
              <FolderPlusIcon size={14} className="composer-context-menu__action-icon" />
              打开文件夹…
            </button>
            <button
              type="button"
              className="composer-context-menu__action"
              disabled={busy}
              aria-pressed={isDefaultWorkspace}
              onClick={() => void runAction(() => selectDefaultWorkspace())}
            >
              <FolderIcon size={14} className="composer-context-menu__action-icon" />
              <span className="composer-context-menu__action-body">
                <span>使用 Nova 工作区</span>
                {defaultWorkspacePath ? (
                  <span className="composer-context-menu__action-sub" title={defaultWorkspacePath}>
                    {defaultWorkspacePath}
                  </span>
                ) : null}
              </span>
              {isDefaultWorkspace ? (
                <CheckIcon size={14} className="composer-context-menu__item-check" />
              ) : null}
            </button>
          </div>
        </div>
      }
    >
      <button
        type="button"
        className="composer-context-chip"
        data-testid="composer-workspace-trigger"
        aria-label={`工作区：${label}`}
        title={currentProjectPath ?? label}
      >
        <FolderIcon size={15} className="composer-context-chip__icon" />
        <span className="composer-context-chip__label">{label}</span>
        <ChevronDownIcon size={13} className="composer-context-chip__chevron" />
      </button>
    </Popover>
  )
}
