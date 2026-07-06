/**
 * MemorySettingsPanel — 跨会话记忆可观测/可编辑（P2-1）
 *
 * 提供：打开记忆目录、scope 信息、文件列表编辑、采集开关（逻辑 P2-2 才接）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type { MemoryScopeFileEntry, MemoryScopeStats } from '../../../shared/memory/types'

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
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isDirty = selectedPath !== null && content !== baselineContent

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

  const handleSelectFile = async (relPath: string): Promise<void> => {
    if (relPath === selectedPath) {
      return
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
        return
      }
      // 放弃脏改动后先清空正文，避免切到 B 时短暂误报「未保存」
      setContent('')
      setBaselineContent('')
    }
    setSelectedPath(relPath)
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
      <div className="settings-panel__warning-banner" role="note">
        ⚠️ 记忆系统为实验性功能，可能不稳定，默认关闭。开启后仍可通过下方开关精细控制各项能力。
      </div>

      <header className="settings-panel__header settings-panel__header--row memory-settings-panel__header">
        <div>
          <h3 className="settings-panel__title">记忆</h3>
          <p className="settings-panel__desc">
            查看与编辑当前工作区的跨会话记忆文件（按工作区哈希隔离）。
          </p>
        </div>
        <div className="settings-panel__header-actions">
          <button
            type="button"
            className="settings-panel__ghost-btn"
            onClick={() => void handleReconcile()}
            disabled={!currentProject || loading}
          >
            重建索引
          </button>
          <button
            type="button"
            className="settings-panel__primary-btn"
            onClick={() => void handleOpenDir()}
            disabled={!currentProject}
          >
            打开记忆目录
          </button>
        </div>
      </header>

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
            <button
              type="button"
              className="memory-settings-panel__copy-btn"
              onClick={handleCopyScopePath}
              title="复制完整路径"
            >
              复制
            </button>
          </div>
          <div className="memory-settings-panel__meta-item memory-settings-panel__meta-item--stats">
            <span className="memory-settings-panel__meta-label">统计</span>
            <span>
              {stats.fileCount} 文件 · 索引 {stats.indexCount} · 磁盘 {formatBytes(stats.diskBytes)}
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
                  一键开启全部能力：直读 MEMORY.md 注入 system prompt、工具轨迹自动采集、每 5 轮用 LLM 提炼为结论写入 episodic、模型可经 memory_search 工具主动检索。关闭后以上能力全部停止。
                </p>
              </div>
              <input
                type="checkbox"
                className="settings-modal__checkbox memory-settings-panel__toggle-input"
                checked={settings.memoryEnabled}
                onChange={e => void updateSetting('memoryEnabled', e.target.checked)}
                aria-label="启用跨会话记忆"
              />
            </div>

            <div className="memory-settings-panel__toggle-row">
              <div className="memory-settings-panel__toggle-copy">
                <span className="memory-settings-panel__toggle-label">
                  自动合并到 MEMORY.md
                  <span className="memory-settings-panel__badge">默认关</span>
                </span>
                <p className="memory-settings-panel__toggle-hint">
                  开启后，高分提炼结论会追加进 MEMORY.md（只追加、不覆盖）。由于这会改写你手写的项目长期记忆，测试版默认关闭；其余能力（采集 / 提炼 / episodic 落盘）不受影响。
                </p>
              </div>
              <input
                type="checkbox"
                className="settings-modal__checkbox memory-settings-panel__toggle-input"
                checked={settings.memoryAutoMergeEnabled}
                onChange={e => void updateSetting('memoryAutoMergeEnabled', e.target.checked)}
                disabled={!settings.memoryEnabled}
                aria-label="自动合并到 MEMORY.md"
              />
            </div>
          </div>
        </section>
      )}

      {error && (
        <div className="settings-modal__error memory-settings-panel__error">{error}</div>
      )}

      <div className="memory-settings-panel__workspace">
        <aside className="memory-settings-panel__file-list">
          {loading && <p className="settings-panel__muted">加载中…</p>}
          {!loading && currentProject && files.length === 0 && (
            <p className="settings-panel__muted">
              暂无记忆文件。可点击「打开记忆目录」手动创建 MEMORY.md。
            </p>
          )}
          {files.map(file => (
            <button
              key={file.relPath}
              type="button"
              className={`memory-settings-panel__file-item${
                selectedPath === file.relPath ? ' memory-settings-panel__file-item--active' : ''
              }`}
              onClick={() => void handleSelectFile(file.relPath)}
            >
              <span className="memory-settings-panel__file-title">
                {file.relPath}
                {selectedPath === file.relPath && isDirty && (
                  <span className="settings-panel__status settings-panel__status--error"> · 未保存</span>
                )}
              </span>
              <span className="memory-settings-panel__file-meta">
                {formatBytes(file.size)} · {formatMtime(file.mtimeMs)}
              </span>
            </button>
          ))}
        </aside>

        <div className="memory-settings-panel__editor">
          {selectedPath ? (
            <>
              <div className="memory-settings-panel__editor-toolbar">
                <span className="memory-settings-panel__editor-path" title={selectedPath}>
                  {selectedPath}
                </span>
                {isDirty && (
                  <span className="settings-panel__status settings-panel__status--error">
                    未保存
                  </span>
                )}
              </div>
              <textarea
                className="memory-settings-panel__textarea"
                value={content}
                onChange={e => setContent(e.target.value)}
                spellCheck={false}
              />
              <div className="memory-settings-panel__editor-footer">
                {status && <span className="settings-panel__status">{status}</span>}
                {!status && isDirty && (
                  <span className="settings-panel__status settings-panel__status--error">
                    有未保存的更改
                  </span>
                )}
                <button
                  type="button"
                  className="settings-panel__primary-btn"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : (
            <p className="settings-panel__muted settings-panel__muted--center">
              {currentProject ? '从左侧选择文件查看或编辑' : '打开项目后可编辑记忆'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
