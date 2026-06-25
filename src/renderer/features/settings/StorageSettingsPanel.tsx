/**
 * StorageSettingsPanel — 存储与数据管理面板（WS3.3）
 *
 * 展示各会话磁盘占用明细，并提供清理入口：
 * - 清理单个会话的 checkpoint 快照
 * - 彻底删除单个会话（含消息、checkpoint、artifacts）
 * - 清理全部会话的过期 checkpoint
 * - 手动运行一次 GC
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { StorageUsageReport, StorageCleanupResult, SessionStorageBreakdown } from '../../../shared/storage/types'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export const StorageSettingsPanel: React.FC = () => {
  const [report, setReport] = useState<StorageUsageReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<StorageCleanupResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.invoke('storage:usage')
      setReport(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载存储统计失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runAction = async <T,>(
    id: string,
    task: () => Promise<T>,
    onSuccess?: (result: T) => void
  ): Promise<void> => {
    setActionId(id)
    setError(null)
    setLastResult(null)
    try {
      const result = await task()
      onSuccess?.(result)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setActionId(null)
    }
  }

  const handlePruneSession = (sessionId: string) => {
    void runAction(
      `prune-${sessionId}`,
      () => window.api.invoke('storage:prune-session-checkpoints', { sessionId }),
      result => setLastResult(result)
    )
  }

  const handleDeleteSession = (sessionId: string) => {
    if (!window.confirm(`确定彻底删除会话「${sessionId}」？\n该操作会删除该会话的所有消息、checkpoint 和命令产物，且无法恢复。`)) {
      return
    }
    void runAction(
      `delete-${sessionId}`,
      () => window.api.invoke('storage:delete-session', { sessionId }),
      result => setLastResult(result)
    )
  }

  const handlePruneAll = () => {
    if (!window.confirm('确定清理所有会话的过期 checkpoint 快照？\n被清理的快照将无法用于回退或拒绝恢复。')) {
      return
    }
    void runAction(
      'prune-all',
      () => window.api.invoke('storage:prune-all-checkpoints'),
      result => setLastResult(result)
    )
  }

  const handleRunGc = () => {
    void runAction(
      'run-gc',
      () => window.api.invoke('storage:run-gc', {}),
      result => setLastResult(result)
    )
  }

  const sessionRows = report?.sessions ?? []

  return (
    <div className="settings-panel">
      <header className="settings-panel__header settings-panel__header--row">
        <div>
          <h3 className="settings-panel__title">存储与数据管理</h3>
          <p className="settings-panel__desc">
            查看会话磁盘占用，并清理 checkpoint 快照或彻底删除不再需要的会话。
          </p>
        </div>
        <button
          type="button"
          className="settings-panel__ghost-btn"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <div className="settings-panel__scroll">
        {error && <div className="settings-modal__error">{error}</div>}

        {lastResult && lastResult.freedBytes > 0 && (
          <div className="storage-result">
            已释放 {formatBytes(lastResult.freedBytes)}，涉及 {lastResult.affectedSessions} 个会话
          </div>
        )}
        {lastResult && lastResult.freedBytes === 0 && (
          <div className="storage-result storage-result--empty">没有可清理的内容</div>
        )}

        <div className="settings-modal__field">
          <label className="settings-modal__label">全局操作</label>
          <div className="storage-actions">
            <button
              type="button"
              className="settings-panel__ghost-btn"
              onClick={handlePruneAll}
              disabled={actionId !== null}
            >
              清理全部过期 checkpoint
            </button>
            <button
              type="button"
              className="settings-panel__ghost-btn"
              onClick={handleRunGc}
              disabled={actionId !== null}
            >
              立即运行 GC
            </button>
          </div>
          <span className="settings-modal__help">
            总占用：{report ? formatBytes(report.totalBytes) : '-'}
            {report && report.orphanBytes > 0 && `（零散数据 ${formatBytes(report.orphanBytes)}）`}
          </span>
        </div>

        <div className="settings-modal__field">
          <label className="settings-modal__label">会话占用明细</label>
          {sessionRows.length === 0 ? (
            <div className="settings-modal__help">暂无可显示的会话数据。</div>
          ) : (
            <div className="storage-table">
              <div className="storage-table__header">
                <span className="storage-table__cell">会话 ID</span>
                <span className="storage-table__cell storage-table__cell--right">消息历史</span>
                <span className="storage-table__cell storage-table__cell--right">Checkpoint</span>
                <span className="storage-table__cell storage-table__cell--right">产物</span>
                <span className="storage-table__cell storage-table__cell--right">合计</span>
                <span className="storage-table__cell storage-table__cell--actions">操作</span>
              </div>
              {sessionRows.map(row => (
                <SessionStorageRow
                  key={row.sessionId}
                  row={row}
                  isBusy={actionId !== null}
                  onPrune={() => handlePruneSession(row.sessionId)}
                  onDelete={() => handleDeleteSession(row.sessionId)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface SessionStorageRowProps {
  row: SessionStorageBreakdown
  isBusy: boolean
  onPrune: () => void
  onDelete: () => void
}

function SessionStorageRow({ row, isBusy, onPrune, onDelete }: SessionStorageRowProps) {
  return (
    <div className="storage-table__row">
      <span className="storage-table__cell storage-table__cell--id" title={row.sessionId}>
        {row.sessionId}
      </span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.historyBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.checkpointsBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.artifactsBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right storage-table__cell--total">
        {formatBytes(row.totalBytes)}
      </span>
      <span className="storage-table__cell storage-table__cell--actions">
        <button
          type="button"
          className="storage-table__action"
          onClick={onPrune}
          disabled={isBusy}
          title="清理该会话的过期 checkpoint 快照"
        >
          清理
        </button>
        <button
          type="button"
          className="storage-table__action storage-table__action--danger"
          onClick={onDelete}
          disabled={isBusy}
          title="彻底删除该会话及其所有数据"
        >
          删除
        </button>
      </span>
    </div>
  )
}
