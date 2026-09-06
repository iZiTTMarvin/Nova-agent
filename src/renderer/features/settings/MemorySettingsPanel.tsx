/**
 * MemorySettingsPanel — 跨会话记忆可观测/可编辑
 *
 * 提供：记忆总开关、已学习记忆查看与忘记、记忆文件列表编辑、目录与索引维护。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { TextArea } from '@astryxdesign/core/TextArea'
import { CloseIcon } from '../../components/Icons'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  MemoryRecordDto,
  MemoryScopeKindDto,
  MemoryKindDto,
  MemoryExplicitnessDto
} from '../../../shared/memory/types'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMtime(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

/** 已学习记忆的类型标签（产品语言） */
const RECORD_KIND_LABELS: Record<MemoryKindDto, string> = {
  preference: '偏好',
  convention: '约定',
  project_fact: '项目事实',
  decision: '决策',
  workflow: '流程',
  gotcha: '踩坑'
}

/** 记忆来源可信度标识 */
const RECORD_EXPLICITNESS_LABELS: Record<MemoryExplicitnessDto, string> = {
  user_explicit: '你告诉我的',
  workspace_verified: '已由工作区确认',
  observed: '根据操作记录学习',
  inferred: '由模型推断'
}

/** 来源摘要中原始来源类型的可读化；文件路径原样展示 */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  user_message: '用户消息',
  tool_result: '工具结果',
  workspace: '工作区'
}

function formatSourceSummary(summary: string): string {
  const mapped = SOURCE_TYPE_LABELS[summary] ?? summary
  return mapped.startsWith('来自') ? mapped.slice(2).trim() : mapped
}

export const MemorySettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [files, setFiles] = useState<MemoryScopeFileEntry[]>([])
  const [stats, setStats] = useState<MemoryScopeStats | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** 最近一次从磁盘加载或保存成功时的正文，用于 dirty 判定 */
  const [baselineContent, setBaselineContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fileEditorOpen, setFileEditorOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── 已学习记忆查看器 ──
  const [recordScope, setRecordScope] = useState<MemoryScopeKindDto>('project')
  const [records, setRecords] = useState<MemoryRecordDto[]>([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [recordsError, setRecordsError] = useState<string | null>(null)
  /** 正在执行「忘记」的记录 id（防重复提交与禁用态） */
  const [forgettingId, setForgettingId] = useState<string | null>(null)

  const isDirty = selectedPath !== null && content !== baselineContent
  const selectedFile = selectedPath
    ? files.find(file => file.relPath === selectedPath) ?? null
    : null

  const loadSettings = useCallback(async () => {
    try {
      const s = await window.api.invoke('settings:get')
      setSettings(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设置失败')
    }
  }, [])

  /** 仅拉列表与统计；切项目时才重拉，不依赖 selectedPath */
  const loadMemoryData = useCallback(async () => {
    if (!currentProject) {
      setFiles([])
      setStats(null)
      setSelectedPath(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [list, st] = await Promise.all([
        window.api.invoke('memory:list-files'),
        window.api.invoke('memory:stats')
      ])
      setFiles(list)
      setStats(st)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载记忆失败')
      setFiles([])
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [currentProject])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    void loadMemoryData()
  }, [loadMemoryData])

  useEffect(() => {
    if (!currentProject) {
      setFileEditorOpen(false)
    }
  }, [currentProject])

  /** 拉取当前 scope 的有效（active）结构化记忆；project 视图需先打开工作区 */
  const loadRecords = useCallback(async (scopeKind: MemoryScopeKindDto) => {
    if (scopeKind === 'project' && !currentProject) {
      setRecords([])
      return
    }
    setRecordsLoading(true)
    setRecordsError(null)
    try {
      const list = await window.api.invoke('memory:list-records', { scopeKind })
      setRecords(list)
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : '加载已学习记忆失败')
      setRecords([])
    } finally {
      setRecordsLoading(false)
    }
  }, [currentProject])

  useEffect(() => {
    void loadRecords(recordScope)
  }, [loadRecords, recordScope])

  const handleSwitchRecordScope = (scopeKind: MemoryScopeKindDto) => {
    if (scopeKind === recordScope) return
    setRecordScope(scopeKind)
  }

  const handleForgetRecord = async (record: MemoryRecordDto) => {
    if (forgettingId !== null) return
    setForgettingId(record.id)
    setRecordsError(null)
    try {
      await window.api.invoke('memory:retract-record', {
        id: record.id,
        scopeKind: record.scopeKind
      })
      // 撤回成功后默认列表不会再返回该记录，直接从视图移除
      setRecords(prev => prev.filter(r => r.id !== record.id))
    } catch (err) {
      setRecordsError(err instanceof Error ? err.message : '忘记失败')
    } finally {
      setForgettingId(null)
    }
  }

  /** files 变化时：当前选中仍合法则保持，否则自动选中首个 */
  useEffect(() => {
    if (files.length === 0) {
      if (selectedPath !== null) {
        setSelectedPath(null)
      }
      return
    }
    if (selectedPath && files.some(f => f.relPath === selectedPath)) {
      return
    }
    setSelectedPath(files[0].relPath)
  }, [files, selectedPath])

  useEffect(() => {
    if (!selectedPath || !currentProject) {
      setContent('')
      setBaselineContent('')
      return
    }
    let cancelled = false
    void window.api
      .invoke('memory:read-file', { relPath: selectedPath })
      .then(text => {
        if (!cancelled) {
          setContent(text)
          setBaselineContent(text)
        }
      })
      .catch(err => {
        if (!cancelled) {
          setContent('')
          setBaselineContent('')
          setError(err instanceof Error ? err.message : '读取失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedPath, currentProject])

  const handleSelectFile = async (relPath: string): Promise<boolean> => {
    if (relPath === selectedPath) {
      return true
    }
    if (isDirty) {
      const response = await window.api.invoke('dialog:confirm', {
        type: 'warning',
        title: '未保存的更改',
        message: '当前文件有未保存的修改，确定要放弃吗？',
        detail: selectedPath ?? undefined,
        buttons: ['继续编辑', '放弃改动'],
        defaultId: 0,
        cancelId: 0
      })
      if (response !== 1) {
        return false
      }
      // 放弃脏改动后先清空正文，避免切到 B 时短暂误报「未保存」
      setContent('')
      setBaselineContent('')
    }
    setSelectedPath(relPath)
    return true
  }

  const handleOpenFileEditor = async (relPath?: string): Promise<void> => {
    if (!currentProject || loading || files.length === 0) {
      return
    }
    if (relPath) {
      const selected = await handleSelectFile(relPath)
      if (!selected) return
    } else if (!selectedPath) {
      setSelectedPath(files[0].relPath)
    }
    setFileEditorOpen(true)
  }

  const handleCloseFileEditor = async (): Promise<void> => {
    if (isDirty) {
      const response = await window.api.invoke('dialog:confirm', {
        type: 'warning',
        title: '未保存的更改',
        message: '当前记忆文件有未保存的修改，确定要关闭编辑器吗？',
        detail: selectedPath ?? undefined,
        buttons: ['继续编辑', '关闭并放弃'],
        defaultId: 0,
        cancelId: 0
      })
      if (response !== 1) {
        return
      }
      setContent(baselineContent)
    }
    setFileEditorOpen(false)
  }

  const updateSetting = async <K extends keyof NovaSettingsDto>(
    key: K,
    value: NovaSettingsDto[K]
  ): Promise<void> => {
    if (!settings) return
    try {
      const next = await window.api.invoke('settings:set', { [key]: value } as Partial<NovaSettingsDto>)
      setSettings(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    }
  }

  const handleOpenDir = async () => {
    setError(null)
    try {
      await window.api.invoke('memory:open-dir')
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开目录失败')
    }
  }

  const handleReconcile = async () => {
    if (!currentProject) return
    setError(null)
    try {
      const result = await window.api.invoke('memory:reconcile')
      setStatus(`索引已重建：新增 ${result.added}，更新 ${result.updated}，删除 ${result.removed}`)
      await loadMemoryData()
      window.setTimeout(() => setStatus(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重建索引失败')
    }
  }

  const handleSave = async () => {
    if (!selectedPath) return
    setSaving(true)
    setError(null)
    try {
      await window.api.invoke('memory:write-file', { relPath: selectedPath, content })
      setBaselineContent(content)
      setStatus('已保存')
      await loadMemoryData()
      window.setTimeout(() => setStatus(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyScopePath = () => {
    if (!stats?.scopeDir) return
    void navigator.clipboard.writeText(stats.scopeDir).then(() => {
      setStatus('路径已复制')
      window.setTimeout(() => setStatus(null), 2000)
    })
  }

  return (
    <div className="settings-panel memory-settings-panel">
      <Banner
        status="warning"
        title="记忆系统为实验性功能，可能不稳定，默认关闭。开启后会启用采集、提炼、召回与主动检索。"
        container="section"
        className="settings-panel__warning-banner"
      />

      <div className="settings-panel__toolbar">
        <Button
          label="重建索引"
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void handleReconcile()}
          isDisabled={!currentProject || loading}
        >
          重建索引
        </Button>
        <Button
          label="打开记忆目录"
          variant="primary"
          size="sm"
          type="button"
          onClick={() => void handleOpenDir()}
          isDisabled={!currentProject}
        >
          打开记忆目录
        </Button>
      </div>

      {!currentProject && (
        <p className="settings-panel__muted memory-settings-panel__empty-hint">
          请先打开工作区项目以管理记忆。
        </p>
      )}

      {currentProject && stats && (
        <div className="memory-settings-panel__meta" aria-label="记忆 scope 信息">
          <div className="memory-settings-panel__meta-item">
            <span className="memory-settings-panel__meta-label">scopeId</span>
            <code className="memory-settings-panel__meta-code">{stats.scopeId}</code>
          </div>
          <div className="memory-settings-panel__meta-item memory-settings-panel__meta-item--path">
            <span className="memory-settings-panel__meta-label">目录</span>
            <code
              className="memory-settings-panel__meta-path"
              title={stats.scopeDir}
            >
              {stats.scopeDir}
            </code>
            <Button
              label="复制完整路径"
              variant="ghost"
              size="sm"
              type="button"
              className="memory-settings-panel__copy-btn"
              onClick={handleCopyScopePath}
            >
              复制
            </Button>
          </div>
          <div className="memory-settings-panel__meta-item memory-settings-panel__meta-item--stats">
            <span className="memory-settings-panel__meta-label">统计</span>
            <span>
              {stats.fileCount} 文件 · 索引 {stats.indexCount} · 磁盘 {formatBytes(stats.diskBytes)}
              {' · 已学习 '}{stats.records.active}
            </span>
          </div>
        </div>
      )}

      {settings && (
        <section className="memory-settings-panel__controls" aria-label="记忆开关">
          <h4 className="memory-settings-panel__section-title">记忆</h4>
          <div className="memory-settings-panel__toggle-group">
            <div className="memory-settings-panel__toggle-row">
              <div className="memory-settings-panel__toggle-copy">
                <span className="memory-settings-panel__toggle-label">
                  启用跨会话记忆
                </span>
                <p className="memory-settings-panel__toggle-hint">
                  开启后，Nova 会从对话与工具轨迹中提炼记忆，并在需要时检索此前的项目约定、偏好和经验。关闭后停止学习和检索。
                </p>
              </div>
              <CheckboxInput
                label="启用跨会话记忆"
                isLabelHidden
                className="memory-settings-panel__toggle-input"
                value={settings.memoryEnabled}
                onChange={checked => void updateSetting('memoryEnabled', checked)}
              />
            </div>
          </div>
        </section>
      )}

      <section className="memory-settings-panel__controls" aria-label="已学习的记忆">
        <h4 className="memory-settings-panel__section-title">已学习的记忆</h4>
        <p className="settings-panel__muted memory-settings-panel__records-hint">
          Nova 从对话与工具使用中自动学习并确认的记忆。忘记某条记忆后，它将不再参与检索与回答。
        </p>
        <div className="memory-settings-panel__records-toolbar">
          <Button
            label="查看项目记忆"
            variant={recordScope === 'project' ? 'primary' : 'secondary'}
            size="sm"
            type="button"
            onClick={() => handleSwitchRecordScope('project')}
          >
            项目
          </Button>
          <Button
            label="查看全局记忆"
            variant={recordScope === 'global' ? 'primary' : 'secondary'}
            size="sm"
            type="button"
            onClick={() => handleSwitchRecordScope('global')}
          >
            全局
          </Button>
        </div>

        {recordsError && (
          <div className="settings-status settings-status--error memory-settings-panel__error">
            {recordsError}
          </div>
        )}

        {recordsLoading && <p className="settings-panel__muted">加载中…</p>}

        {!recordsLoading && recordScope === 'project' && !currentProject && (
          <p className="settings-panel__muted">请先打开工作区项目以查看项目记忆。</p>
        )}

        {!recordsLoading && records.length === 0 && (recordScope === 'global' || currentProject) && (
          <p className="settings-panel__muted">
            {recordScope === 'project' ? '当前项目还没有已学习的记忆。' : '还没有已学习的全局记忆。'}
          </p>
        )}

        <ul className="memory-settings-panel__record-list">
          {records.map(record => (
            <li key={record.id} className="memory-settings-panel__record-item">
              <div className="memory-settings-panel__record-main">
                <p className="memory-settings-panel__record-content">{record.content}</p>
                <div className="memory-settings-panel__record-meta">
                  <span className="memory-settings-panel__record-kind">
                    {RECORD_KIND_LABELS[record.kind]}
                  </span>
                  <span>{RECORD_EXPLICITNESS_LABELS[record.explicitness]}</span>
                  <span>来源：{formatSourceSummary(record.sourceSummary)}</span>
                  <span>更新：{formatMtime(record.updatedAt)}</span>
                </div>
                {record.memoryKey && (
                  <details className="memory-settings-panel__record-details">
                    <summary>技术信息</summary>
                    <div className="memory-settings-panel__record-detail-row">
                      <span>标识</span>
                      <code className="memory-settings-panel__meta-code">{record.memoryKey}</code>
                    </div>
                  </details>
                )}
              </div>
              <Button
                label={forgettingId === record.id ? '忘记中…' : '忘记'}
                variant="ghost"
                size="sm"
                type="button"
                className="memory-settings-panel__forget-btn"
                onClick={() => void handleForgetRecord(record)}
                isDisabled={forgettingId !== null}
              >
                {forgettingId === record.id ? '忘记中…' : '忘记'}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {error && (
        <div className="settings-status settings-status--error memory-settings-panel__error">{error}</div>
      )}

      <section className="memory-settings-panel__files-section" aria-label="记忆文件">
        <div className="memory-settings-panel__files-heading">
          <div className="memory-settings-panel__files-copy">
            <h4 className="memory-settings-panel__section-title">记忆文件</h4>
            <p className="settings-panel__muted memory-settings-panel__files-hint">
              手动项目记忆与自动回合摘要会参与索引，可在独立编辑器中维护。
            </p>
          </div>
          {currentProject && (
            <span className="memory-settings-panel__file-count">
              {loading ? '同步中…' : `${files.length} 文件`}
            </span>
          )}
        </div>

        <div className="memory-settings-panel__file-dock">
          <div className="memory-settings-panel__file-dock-main">
            {!currentProject && (
              <p className="settings-panel__muted">打开项目后可查看和编辑记忆文件。</p>
            )}
            {loading && <p className="settings-panel__muted">正在同步记忆文件…</p>}
            {!loading && currentProject && files.length === 0 && (
              <p className="settings-panel__muted">
                暂无记忆文件。打开目录后可手动创建 MEMORY.md。
              </p>
            )}
            {!loading && files.length > 0 && (
              <div className="memory-settings-panel__file-chip-list">
                {files.slice(0, 3).map(file => (
                  <button
                    key={file.relPath}
                    type="button"
                    className="memory-settings-panel__file-chip"
                    onClick={() => void handleOpenFileEditor(file.relPath)}
                  >
                    <span className="memory-settings-panel__file-chip-name">{file.relPath}</span>
                    <span className="memory-settings-panel__file-chip-meta">
                      {formatBytes(file.size)} · {formatMtime(file.mtimeMs)}
                    </span>
                  </button>
                ))}
                {files.length > 3 && (
                  <span className="memory-settings-panel__file-chip-more">
                    +{files.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
          {currentProject && files.length === 0 ? (
            <Button
              label="打开记忆目录"
              variant="secondary"
              size="sm"
              type="button"
              className="memory-settings-panel__file-dock-action"
              onClick={() => void handleOpenDir()}
            >
              打开目录
            </Button>
          ) : (
            <Button
              label="编辑记忆文件"
              variant="secondary"
              size="sm"
              type="button"
              className="memory-settings-panel__file-dock-action"
              onClick={() => void handleOpenFileEditor()}
              isDisabled={!currentProject || loading || files.length === 0}
            >
              编辑文件
            </Button>
          )}
        </div>
      </section>

      {fileEditorOpen && (
        <Dialog
          isOpen={fileEditorOpen}
          onOpenChange={nextOpen => {
            if (!nextOpen) void handleCloseFileEditor()
          }}
          purpose="form"
          padding={0}
          width="min(1080px, calc(100vw - 48px))"
          maxHeight="min(86vh, 760px)"
          className="memory-file-dialog"
          aria-labelledby="memory-file-dialog-title"
        >
          <header className="memory-file-dialog__header">
            <div className="memory-file-dialog__title-group">
              <h3 id="memory-file-dialog-title" className="memory-file-dialog__title">
                编辑记忆文件
              </h3>
              <p className="settings-panel__muted memory-file-dialog__subtitle">
                MEMORY.md 适合手写项目规则；episodic/summary.md 是回合摘要归档。
              </p>
            </div>
            <div className="memory-file-dialog__actions">
              <Button
                label="打开记忆目录"
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void handleOpenDir()}
                isDisabled={!currentProject}
              >
                打开目录
              </Button>
              <IconButton
                label="关闭编辑器"
                icon={<CloseIcon size={16} />}
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void handleCloseFileEditor()}
              />
            </div>
          </header>

          {error && (
            <div className="settings-status settings-status--error memory-file-dialog__error">
              {error}
            </div>
          )}

          <div className="memory-file-dialog__body">
            <div className="memory-settings-panel__workspace">
              <aside className="memory-settings-panel__file-list" aria-label="记忆文件列表">
                {loading && <p className="settings-panel__muted">加载中…</p>}
                {!loading && currentProject && files.length === 0 && (
                  <p className="settings-panel__muted memory-settings-panel__file-empty">
                    暂无记忆文件。可点击「打开记忆目录」手动创建 MEMORY.md。
                  </p>
                )}
                {files.map(file => (
                  <ClickableCard
                    key={file.relPath}
                    label={file.relPath}
                    variant="transparent"
                    padding={0}
                    width="100%"
                    className={`memory-settings-panel__file-item${
                      selectedPath === file.relPath ? ' memory-settings-panel__file-item--active' : ''
                    }`}
                    onClick={() => void handleSelectFile(file.relPath)}
                  >
                    <span className="memory-settings-panel__file-title-row">
                      <span className="memory-settings-panel__file-title">{file.relPath}</span>
                      {selectedPath === file.relPath && isDirty && (
                        <span className="settings-panel__status settings-panel__status--error">
                          未保存
                        </span>
                      )}
                    </span>
                    <span className="memory-settings-panel__file-meta">
                      {formatBytes(file.size)} · {formatMtime(file.mtimeMs)}
                    </span>
                  </ClickableCard>
                ))}
              </aside>

              <div className="memory-settings-panel__editor">
                {selectedPath ? (
                  <>
                    <div className="memory-settings-panel__editor-toolbar">
                      <div className="memory-settings-panel__editor-title-group">
                        <span className="memory-settings-panel__editor-path" title={selectedPath}>
                          {selectedPath}
                        </span>
                        {selectedFile && (
                          <span className="memory-settings-panel__editor-meta">
                            {formatBytes(selectedFile.size)} · {formatMtime(selectedFile.mtimeMs)}
                          </span>
                        )}
                      </div>
                      {isDirty && (
                        <span className="settings-panel__status settings-panel__status--error">
                          未保存
                        </span>
                      )}
                      <Button
                        label={saving ? '保存中…' : '保存'}
                        variant="primary"
                        size="sm"
                        type="button"
                        className="memory-settings-panel__editor-save"
                        onClick={() => void handleSave()}
                        isDisabled={saving || !isDirty}
                      >
                        {saving ? '保存中…' : '保存'}
                      </Button>
                    </div>
                    <div className="memory-settings-panel__textarea-shell">
                      <TextArea
                        label="记忆文件内容"
                        isLabelHidden
                        className="memory-settings-panel__textarea"
                        value={content}
                        onChange={value => setContent(value)}
                        hasSpellCheck={false}
                        width="100%"
                      />
                    </div>
                    <div className="memory-settings-panel__editor-footer" aria-live="polite">
                      {status && <span className="settings-panel__status">{status}</span>}
                      {!status && isDirty && (
                        <span className="settings-panel__status settings-panel__status--error">
                          有未保存的更改
                        </span>
                      )}
                      {!status && !isDirty && (
                        <span className="settings-panel__muted">已同步</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="memory-settings-panel__editor-empty">
                    <p className="settings-panel__muted settings-panel__muted--center">
                      {currentProject ? '从左侧选择文件查看或编辑' : '打开项目后可编辑记忆'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
