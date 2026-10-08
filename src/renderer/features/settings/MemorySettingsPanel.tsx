/**
 * MemorySettingsPanel — 跨会话记忆可观测/可编辑
 *
 * 提供：记忆总开关、已学习记忆查看与忘记、记忆文件列表编辑、目录与索引维护。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Switch } from '@astryxdesign/core/Switch'
import { TextArea } from '@astryxdesign/core/TextArea'
import { CloseIcon } from '../../components/Icons'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { formatSettingsDateTime } from './formatDateTime'
import { containsSensitiveMemoryText } from '../../../shared/memory/sensitiveText'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import type {
  MemoryFileDto,
  MemoryScopeStats,
  MemoryEntryDto,
  MemorySnapshotPreview,
  MemoryLegacyDto,
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
  return formatSettingsDateTime(ms)
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

export const MemorySettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [files, setFiles] = useState<MemoryFileDto[]>([])
  const [stats, setStats] = useState<MemoryScopeStats | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** 最近一次从磁盘加载或保存成功时的正文，用于 dirty 判定 */
  const [baselineContent, setBaselineContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingSaving, setSettingSaving] = useState(false)
  const [fileEditorOpen, setFileEditorOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── 已学习记忆查看器 ──
  const [recordScope, setRecordScope] = useState<MemoryScopeKindDto>('project')
  const [records, setRecords] = useState<MemoryEntryDto[]>([])
  const [preview, setPreview] = useState<MemorySnapshotPreview | null>(null)
  const [legacy, setLegacy] = useState<MemoryLegacyDto[]>([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [recordsError, setRecordsError] = useState<string | null>(null)
  /** 正在执行「忘记」的记录 id（防重复提交与禁用态） */
  const [forgettingId, setForgettingId] = useState<string | null>(null)
  const context = `${currentProject ?? ''}/${recordScope}`
  const requestContext = useRef({ key: context, epoch: 0 })
  if (requestContext.current.key !== context) requestContext.current = { key: context, epoch: requestContext.current.epoch + 1 }

  const isDirty = selectedPath !== null && content !== baselineContent
  const selectedFile = selectedPath
    ? files.find(file => file.relPath === selectedPath) ?? null
    : null

  const refreshPreview = useCallback(async () => {
    setPreview(await window.api.invoke('memory:snapshot-preview'))
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.api.invoke('memory:snapshot-preview'), window.api.invoke('memory:list-legacy')]).then(([snapshot, dirs]) => {
      if (!cancelled) { setPreview(snapshot); setLegacy(dirs) }
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : '加载记忆预览失败') })
    return () => { cancelled = true }
  }, [currentProject])

  const updateEntry = async (entry: MemoryEntryDto, action: 'pin' | 'approve' | 'reject') => {
    if (forgettingId) return
    const epoch = requestContext.current.epoch
    setForgettingId(entry.id)
    try {
      if (action === 'pin') await window.api.invoke('memory:set-entry-pinned', { scopeKind: recordScope, id: entry.id, pinned: !entry.pinned })
      else await window.api.invoke('memory:decide-inbox', { scopeKind: recordScope, id: entry.id, decision: action })
      if (epoch !== requestContext.current.epoch) return
      await loadRecords(recordScope); await loadMemoryData(); await refreshPreview()
    } catch (err) { setRecordsError(err instanceof Error ? err.message : '更新记忆失败') }
    finally { setForgettingId(null) }
  }

  const organizeFile = async (relPath: string) => {
    const response = await window.api.invoke('dialog:confirm', { type: 'question', title: '整理记忆', message: '将调用模型合并相似条目，可能产生 API 费用。', buttons: ['取消', '立即整理'], defaultId: 0, cancelId: 0 })
    if (response !== 1) return
    try {
      const result = await window.api.invoke('memory:consolidate', { scopeKind: recordScope, relPath })
      setStatus(`整理完成：合并 ${result.merged} 组，归档 ${result.retired} 条`)
      await loadRecords(recordScope); await loadMemoryData(); await refreshPreview()
    } catch (err) { setError(err instanceof Error ? err.message : '整理失败') }
  }

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
    const epoch = requestContext.current.epoch
    if (!currentProject && recordScope === 'project') {
      setFiles([])
      setStats(null)
      setSelectedPath(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [list, st] = await Promise.all([
        window.api.invoke('memory:list-files', { scopeKind: recordScope }),
        window.api.invoke('memory:stats', { scopeKind: recordScope })
      ])
      if (epoch !== requestContext.current.epoch) return
      setFiles(list)
      setStats(st)
    } catch (err) {
      if (epoch !== requestContext.current.epoch) return
      setError(err instanceof Error ? err.message : '加载记忆失败')
      setFiles([])
      setStats(null)
    } finally {
      if (epoch === requestContext.current.epoch) setLoading(false)
    }
  }, [currentProject, recordScope])

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
    const epoch = requestContext.current.epoch
    if (scopeKind === 'project' && !currentProject) {
      setRecords([])
      return
    }
    setRecordsLoading(true)
    setRecordsError(null)
    try {
      const list = await window.api.invoke('memory:list-entries', { scopeKind })
      if (epoch !== requestContext.current.epoch) return
      setRecords(list)
    } catch (err) {
      if (epoch !== requestContext.current.epoch) return
      setRecordsError(err instanceof Error ? err.message : '加载已学习记忆失败')
      setRecords([])
    } finally {
      if (epoch === requestContext.current.epoch) setRecordsLoading(false)
    }
  }, [currentProject])

  useEffect(() => {
    void loadRecords(recordScope)
  }, [loadRecords, recordScope])

  const handleSwitchRecordScope = async (scopeKind: MemoryScopeKindDto) => {
    if (scopeKind === recordScope) return
    if (isDirty) {
      const response = await window.api.invoke('dialog:confirm', { type: 'warning', title: '未保存的更改', message: '切换范围会放弃当前文件的修改，是否继续？', buttons: ['继续编辑', '放弃改动'], defaultId: 0, cancelId: 0 })
      if (response !== 1) return
    }
    setSelectedPath(null); setContent(''); setBaselineContent(''); setFileEditorOpen(false); setFiles([]); setRecords([])
    setRecordScope(scopeKind)
  }

  const handleForgetRecord = async (record: MemoryEntryDto) => {
    if (forgettingId !== null) return
    const epoch = requestContext.current.epoch
    const response = await window.api.invoke('dialog:confirm', { type: 'warning', title: '彻底遗忘记忆', message: '将清除这条记忆及其证据、索引和派生视图。', detail: '已保存的会话记忆快照和整理、迁移备份会一并清除；聊天记录里已出现过的内容不会改动。', buttons: ['取消', '遗忘'], defaultId: 0, cancelId: 0 })
    if (response !== 1) return
    if (epoch !== requestContext.current.epoch) return
    setForgettingId(record.id)
    setRecordsError(null)
    try {
      await window.api.invoke('memory:forget-entry', {
        id: record.id,
        scopeKind: record.scopeKind
      })
      if (epoch !== requestContext.current.epoch) return
      // 撤回成功后默认列表不会再返回该记录，直接从视图移除
      setRecords(prev => prev.filter(r => r.id !== record.id))
      await refreshPreview()
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
    if (!selectedPath || !currentProject && recordScope === 'project') {
      setContent('')
      setBaselineContent('')
      return
    }
    let cancelled = false
    void window.api
      .invoke('memory:read-file', { scopeKind: recordScope, relPath: selectedPath })
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
  }, [selectedPath, currentProject, recordScope])

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
    if (!currentProject && recordScope === 'project' || loading || files.length === 0) {
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
    setSettingSaving(true)
    setError(null)
    try {
      const next = await window.api.invoke('settings:set', { [key]: value } as Partial<NovaSettingsDto>)
      setSettings(next)
      setStatus('已保存')
      window.setTimeout(() => setStatus(null), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSettingSaving(false)
    }
  }

  const handleOpenDir = async () => {
    setError(null)
    try {
      await window.api.invoke('memory:open-dir', { scopeKind: recordScope })
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开目录失败')
    }
  }

  const handleReconcile = async () => {
    if (!currentProject && recordScope === 'project') return
    setError(null)
    try {
      const result = await window.api.invoke('memory:reconcile', { scopeKind: recordScope })
      setStatus(`索引已重建：新增 ${result.added}，更新 ${result.updated}，删除 ${result.removed}`)
      await loadMemoryData()
      window.setTimeout(() => setStatus(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重建索引失败')
    }
  }

  const handleSave = async () => {
    if (!selectedPath) return
    const epoch = requestContext.current.epoch
    setSaving(true)
    setError(null)
    try {
      if (containsSensitiveMemoryText(content)) {
        const response = await window.api.invoke('dialog:confirm', { type: 'warning', title: '记忆中可能含有密钥',
          message: '保存的内容可能包含密钥、认证信息或私密数据。记忆可能在后续对话中发送给模型。',
          detail: '只有你确认后才会保存。建议先移除敏感内容。', buttons: ['取消', '仍然保存'], defaultId: 0, cancelId: 0 })
        if (response !== 1 || epoch !== requestContext.current.epoch) return
      }
      const result = await window.api.invoke('memory:write-file', { scopeKind: recordScope, relPath: selectedPath, content })
      if (epoch !== requestContext.current.epoch) return
      setBaselineContent(content)
      setStatus(result.parseIssues ? `已保存，存在 ${result.parseIssues} 个解析问题，请检查条目格式。` : '已保存')
      const savedContent = await window.api.invoke('memory:read-file', { scopeKind: recordScope, relPath: selectedPath })
      if (epoch !== requestContext.current.epoch) return
      setContent(savedContent); setBaselineContent(savedContent)
      await loadMemoryData()
      await loadRecords(recordScope)
      await refreshPreview()
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
        title="记忆系统为实验性功能，默认关闭。开启后新会话加载核心记忆并可按需检索；自动学习需单独开启。"
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
          isDisabled={(!currentProject && recordScope === 'project') || loading}
        >
          重建索引
        </Button>
      </div>

      {!currentProject && (
        <p className="settings-panel__muted memory-settings-panel__empty-hint">
          项目记忆需先打开工作区；全局记忆仍可管理。
        </p>
      )}

      {currentProject && stats && (
        <div className="memory-settings-panel__meta" aria-label="记忆 scope 信息">
          <div className="memory-settings-panel__meta-item">
            <span className="memory-settings-panel__meta-label">工作区</span>
            <span className="memory-settings-panel__meta-workspace" title={currentProject}>
              {currentProject}
            </span>
          </div>
          <div className="memory-settings-panel__meta-item">
            <span className="memory-settings-panel__meta-label">作用范围</span>
            <span>当前工作区</span>
          </div>
          <div className="memory-settings-panel__meta-item memory-settings-panel__meta-item--stats">
            <span className="memory-settings-panel__meta-label">统计</span>
            <span>
              {stats.fileCount} 文件 · 索引 {stats.indexCount} · 磁盘 {formatBytes(stats.diskBytes)}
              {' · 生效 '}{stats.entries.topics}{' · 待批准 '}{stats.entries.inbox}{' · 归档 '}{stats.entries.archive}
            </span>
          </div>
          <details className="memory-settings-panel__meta-details">
            <summary>技术信息</summary>
            <div className="memory-settings-panel__meta-item">
              <span className="memory-settings-panel__meta-label">scopeId</span>
              <code className="memory-settings-panel__meta-code">{stats.scopeId}</code>
            </div>
            <div className="memory-settings-panel__meta-item memory-settings-panel__meta-item--path">
              <span className="memory-settings-panel__meta-label">目录</span>
              <code className="memory-settings-panel__meta-path" title={stats.scopeDir}>
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
          </details>
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
                  开启后，新会话带上核心记忆，并可按需检索约定、偏好和经验。自动学习需另行开启；关闭记忆后停止采集、学习和检索。
                </p>
              </div>
              <Switch
                label="启用跨会话记忆"
                isLabelHidden
                className="memory-settings-panel__toggle-input"
                value={settings.memoryEnabled}
                onChange={checked => void updateSetting('memoryEnabled', checked)}
                isDisabled={settingSaving}
              />
            </div>
          </div>
          <div className="memory-settings-panel__toggle-row">
            <div className="memory-settings-panel__toggle-copy">
              <span className="memory-settings-panel__toggle-label">自动从对话中学习</span>
              <p className="memory-settings-panel__toggle-hint">默认关闭。开启后后台提炼和整理会调用模型，可能产生 API 费用。</p>
            </div>
            <Switch label="自动从对话中学习" isLabelHidden value={settings.memoryAutoExtractEnabled} onChange={checked => void updateSetting('memoryAutoExtractEnabled', checked)} isDisabled={settingSaving || !settings.memoryEnabled} />
          </div>
        </section>
      )}

      <section className="memory-settings-panel__controls" aria-label="开局记忆预览">
        <h4 className="memory-settings-panel__section-title">开局记忆预览</h4>
        <p>全局 {preview?.globalCoreCount ?? 0} 条 · 项目 {preview?.projectCoreCount ?? 0} 条 · 预算外 {preview?.omittedCoreCount ?? 0} 条</p>
        <pre className="memory-settings-panel__preview">{preview?.text ?? '暂无开局记忆'}</pre>
      </section>
      {stats?.diagnostic && <p role="alert">{stats.diagnostic}</p>}
      {stats && stats.indexStatus !== 'ok' && <p role="alert">{stats.indexStatus === 'dirty' ? '索引待重建' : '索引不可用，使用文件检索'}</p>}
      {!!stats?.ledgerBadLines && <p role="alert">账本存在 {stats.ledgerBadLines} 个坏行，请检查原文件；坏行已保留。</p>}
      {files.filter(file => file.needsOrganization).map(file => <div key={file.relPath}><span>{file.relPath} 条目较多，建议整理。</span><Button label={`立即整理 ${file.relPath}`} onClick={() => void organizeFile(file.relPath)} isDisabled={file.readOnly}>立即整理</Button></div>)}
      {legacy.map(dir => <div key={dir.oldHash}><span>未关联的旧记忆：{dir.oldHash} · {dir.fileCount} 文件</span><Button label={`删除旧记忆 ${dir.oldHash}`} onClick={() => void (async () => {
        const response = await window.api.invoke('dialog:confirm', { type: 'warning', title: '删除旧记忆', message: `永久删除未关联目录 ${dir.oldHash}？`, buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 })
        if (response !== 1) return
        try { await window.api.invoke('memory:delete-legacy', { oldHash: dir.oldHash }); setLegacy(await window.api.invoke('memory:list-legacy')) }
        catch (err) { setError(err instanceof Error ? err.message : '删除失败') }
      })()}>删除</Button></div>)}

      <section className="memory-settings-panel__controls" aria-label="已学习的记忆">
        <h4 className="memory-settings-panel__section-title">已学习的记忆</h4>
        <p className="settings-panel__muted memory-settings-panel__records-hint">
          主题条目可置顶或彻底遗忘；待批准条目不会进入检索和开局快照。
        </p>
        <div className="memory-settings-panel__records-toolbar">
          <Button
            label="查看项目记忆"
            variant={recordScope === 'project' ? 'primary' : 'secondary'}
            size="sm"
            type="button"
            onClick={() => handleSwitchRecordScope('project')}
            isDisabled={saving || forgettingId !== null}
          >
            项目
          </Button>
          <Button
            label="查看全局记忆"
            variant={recordScope === 'global' ? 'primary' : 'secondary'}
            size="sm"
            type="button"
            onClick={() => handleSwitchRecordScope('global')}
            isDisabled={saving || forgettingId !== null}
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
          {records.map((record, index) => (
            <li key={record.id} className="memory-settings-panel__record-item">
              <div className="memory-settings-panel__record-main">
                {(index === 0 || records[index - 1].relPath !== record.relPath) && <h5>{record.relPath}{record.location === 'inbox' ? ' · 待批准' : record.location === 'archive' ? ' · 历史归档' : ''}</h5>}
                <p className="memory-settings-panel__record-content">{record.text}</p>
                <div className="memory-settings-panel__record-meta">
                  <span className="memory-settings-panel__record-kind">
                    {RECORD_KIND_LABELS[record.kind]}
                  </span>
                  <span>{RECORD_EXPLICITNESS_LABELS[record.explicitness]}</span>
                  <span>证据 {record.evidenceCount} 条</span>
                  <span>最近观察：{formatMtime(record.lastSeenAt)}</span>
                  {record.needsVerification && <span>需要核对</span>}
                  {record.pinned && <span>已置顶</span>}
                </div>
                {record.key && (
                  <details className="memory-settings-panel__record-details">
                    <summary>技术信息</summary>
                    <div className="memory-settings-panel__record-detail-row">
                      <span>标识</span>
                      <code className="memory-settings-panel__meta-code">{record.key}</code>
                    </div>
                  </details>
                )}
              </div>
              <Button label={record.pinned ? '取消置顶' : '置顶'} onClick={() => void updateEntry(record, 'pin')} isDisabled={forgettingId !== null}>{record.pinned ? '取消置顶' : '置顶'}</Button>
              {record.location === 'inbox' && <><Button label="批准" onClick={() => void updateEntry(record, 'approve')} isDisabled={forgettingId !== null}>批准</Button><Button label="拒绝" onClick={() => void updateEntry(record, 'reject')} isDisabled={forgettingId !== null}>拒绝</Button></>}
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
      {status && !fileEditorOpen && (
        <div className="settings-status settings-status--ok memory-settings-panel__error" role="status">
          {status}
        </div>
      )}

      <section className="memory-settings-panel__files-section" aria-label="记忆文件">
        <Button label="清除操作摘要" isDisabled={!currentProject || stats?.readOnly} onClick={() => void (async () => {
          const response = await window.api.invoke('dialog:confirm', { type: 'warning', title: '清除操作摘要', message: '永久清除当前项目的操作摘要？主题记忆不会受影响。', buttons: ['取消', '清除'], defaultId: 0, cancelId: 0 })
          if (response !== 1) return
          try { await window.api.invoke('memory:clear-episodic'); await loadMemoryData(); await refreshPreview() }
          catch (err) { setError(err instanceof Error ? err.message : '清除摘要失败') }
        })()}>清除操作摘要</Button>
        <div className="memory-settings-panel__files-heading">
          <div className="memory-settings-panel__files-copy">
            <h4 className="memory-settings-panel__section-title">记忆文件</h4>
            <p className="settings-panel__muted memory-settings-panel__files-hint">
              手写内容请写在 notes.md；MEMORY.md 是生成视图，请编辑主题文件。
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
                暂无记忆文件。打开目录后可手动创建 notes.md。
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
          <div className="memory-settings-panel__file-dock-actions">
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
            <Button
              label="编辑记忆文件"
              variant="secondary"
              size="sm"
              type="button"
              className="memory-settings-panel__file-dock-action"
              onClick={() => void handleOpenFileEditor()}
              isDisabled={(!currentProject && recordScope === 'project') || loading || files.length === 0}
            >
              编辑文件
            </Button>
          </div>
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
                手写内容请写在 notes.md。MEMORY.md 只读，请编辑主题文件。
              </p>
            </div>
            <div className="memory-file-dialog__actions">
              <Button
                label="打开记忆目录"
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void handleOpenDir()}
                isDisabled={!currentProject && recordScope === 'project'}
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
                    暂无记忆文件。可点击「打开记忆目录」手动创建 notes.md。
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
                        isDisabled={saving || !isDirty || selectedFile?.readOnly}
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
                        isDisabled={selectedFile?.readOnly}
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
