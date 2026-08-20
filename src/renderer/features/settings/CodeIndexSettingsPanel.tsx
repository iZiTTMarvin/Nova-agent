import React, { useCallback, useEffect, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import type { CodeIndexFailureCode, CodeIndexStatusDto } from '../../../shared/code-index'
import type { NovaSettingsDto } from '../../../shared/settings/types'
import {
  selectCurrentCodeIndexError,
  selectCurrentCodeIndexStatus,
  useCodeIndexStore
} from '../../stores/useCodeIndexStore'
import { useSettingsStore } from '../../stores/useSettingsStore'

export const CodeIndexSettingsPanel: React.FC = () => {
  const currentProject = useSettingsStore(state => state.currentProject)
  const snapshot = useCodeIndexStore(selectCurrentCodeIndexStatus)
  const statusError = useCodeIndexStore(selectCurrentCodeIndexError)
  const refreshStatus = useCodeIndexStore(state => state.refreshStatus)
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [commandPending, setCommandPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await window.api.invoke('settings:get'))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载设置失败')
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    // 面板按工作区主动拉快照，不能依赖此前是否收过状态事件。
    void refreshStatus()
  }, [currentProject, refreshStatus])

  const updateEnabled = async (enabled: boolean): Promise<void> => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const next = await window.api.invoke('settings:set', { codeIndexEnabled: enabled })
      setSettings(next)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  const runCommand = async (command: 'rebuild' | 'open-dir'): Promise<void> => {
    setCommandPending(true)
    setError(null)
    try {
      if (command === 'rebuild') {
        await window.api.invoke('codeindex:rebuild')
        await refreshStatus()
      } else {
        await window.api.invoke('codeindex:open-dir')
      }
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : '操作失败')
    } finally {
      setCommandPending(false)
    }
  }

  const enabledForSession = snapshot?.enabled === true

  return (
    <div className="settings-panel code-index-settings-panel">
      <Banner
        status="warning"
        title="代码索引是实验性功能，默认关闭。首次建立期间不会阻塞聊天。"
        container="section"
        className="settings-panel__warning-banner"
      />

      <div className="settings-panel__toolbar">
        <Button
          label="重建索引"
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void runCommand('rebuild')}
          isDisabled={!currentProject || !enabledForSession || commandPending}
        >
          重建索引
        </Button>
        <Button
          label="打开索引目录"
          variant="primary"
          size="sm"
          type="button"
          onClick={() => void runCommand('open-dir')}
          isDisabled={!currentProject || commandPending}
        >
          打开索引目录
        </Button>
      </div>

      {!currentProject && (
        <p className="settings-panel__muted code-index-settings-panel__empty">
          请先打开工作区项目以查看代码索引。
        </p>
      )}

      {currentProject && (
        <div className="code-index-settings-panel__status-card" aria-live="polite">
          <StatusRow label="状态" value={formatStatus(snapshot)} />
          <StatusRow label="最后更新" value={formatRelativeTime(snapshot?.lastCompletedAt ?? null)} />
          <StatusRow label="数据库" value={formatBytes(snapshot?.databaseBytes ?? 0)} />
        </div>
      )}

      {settings && (
        <section className="code-index-settings-panel__controls" aria-label="代码索引开关">
          <h4 className="code-index-settings-panel__section-title">代码索引</h4>
          <div className="code-index-settings-panel__toggle-row">
            <div className="code-index-settings-panel__toggle-copy">
              <span className="code-index-settings-panel__toggle-label">启用代码索引</span>
              <p className="code-index-settings-panel__toggle-hint">
                为当前工作区建立本地符号与依赖索引，帮助 Agent 更快定位代码。
              </p>
              <p className="code-index-settings-panel__toggle-hint">
                索引只保存结构信息，不复制源码，可随时删除重建。
              </p>
              <p className="code-index-settings-panel__toggle-hint code-index-settings-panel__toggle-hint--important">
                对新建会话生效，不影响正在进行的会话。
              </p>
            </div>
            <CheckboxInput
              label="启用代码索引"
              isLabelHidden
              value={settings.codeIndexEnabled}
              onChange={checked => void updateEnabled(checked)}
              isDisabled={saving}
            />
          </div>
        </section>
      )}

      {currentProject && snapshot?.enabled && (
        <CoverageDetails snapshot={snapshot} />
      )}

      {snapshot?.failure && (
        <div className="settings-status settings-status--warning settings-status--gap" role="status">
          {formatFailureCategory(snapshot.failure.code)}
        </div>
      )}

      {(error || statusError) && (
        <div className="settings-status settings-status--error" role="alert">
          {error ?? statusError}
        </div>
      )}
    </div>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="code-index-settings-panel__status-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function CoverageDetails({ snapshot }: { snapshot: CodeIndexStatusDto }) {
  const skipped = snapshot.coverage.unsupportedFiles + snapshot.coverage.oversizedFiles
  return (
    <details className="code-index-settings-panel__coverage">
      <summary>
        已跳过 {skipped} 个文件（暂不支持的语言或文件过大） · {snapshot.coverage.parseFailures} 个文件解析失败
      </summary>
      <dl>
        <div><dt>符合索引条件</dt><dd>{snapshot.coverage.eligibleFiles}</dd></div>
        <div><dt>已索引</dt><dd>{snapshot.coverage.indexedFiles}</dd></div>
        <div><dt>未解析关系</dt><dd>{snapshot.coverage.unresolvedRelations}</dd></div>
      </dl>
    </details>
  )
}

function formatStatus(snapshot: CodeIndexStatusDto | null): string {
  if (!snapshot) return '读取中…'
  if (!snapshot.enabled) return '当前会话未启用'
  const progress = snapshot.progress
  switch (snapshot.status) {
    case 'building':
      return progress && progress.total > 0
        ? `索引中 · ${progress.completed} / ${progress.total} 个文件`
        : '正在建立索引'
    case 'ready':
      return '可用'
    case 'updating':
      return '正在更新'
    case 'degraded':
      return '部分可用，需要检查'
    case 'unavailable':
      return '暂时不可用'
    case 'idle':
      return snapshot.activeGeneration === null ? '等待建立索引' : '可用'
  }
}

function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) return '尚未完成'
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleDateString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatFailureCategory(code: CodeIndexFailureCode): string {
  switch (code) {
    case 'worker_missing':
    case 'worker_crash':
      return '索引进程异常'
    case 'grammar_missing':
      return '语法资源缺失'
    case 'db_corrupt':
      return '索引数据库损坏'
    case 'parser_failure':
      return '解析器执行失败'
    case 'resolver_timeout':
      return '关系解析超时'
    case 'build_cancelled':
      return '索引构建被取消'
    case 'stale_result_rejected':
      return '旧结果已被丢弃'
    case 'bulk_change_rebuild':
      return '批量变更需要重建'
    case 'watcher_failed':
      return '文件监听异常'
    case 'storage_open_failed':
      return '索引数据库打开失败'
    case 'storage_commit_failed':
      return '索引数据库写入失败'
    case 'storage_read_failed':
      return '索引数据库读取失败'
    case 'fence_release_failed':
      return '索引锁释放失败'
  }
}
