/**
 * StorageSettingsPanel — 存储与数据管理面板
 *
 * 展示各会话磁盘占用明细，并提供清理入口：
 * - 清理单个会话的 checkpoint 快照
 * - 彻底删除单个会话（含消息、checkpoint、artifacts）
 * - 清理全部会话的过期 checkpoint
 * - 手动运行一次 GC
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { SettingsCard, SettingsGlassPanel, SettingsPage } from './settingsKit'
import type { StorageUsageReport, StorageCleanupResult, SessionStorageBreakdown } from '../../../shared/storage/types'
import { formatSettingsDateTime } from './formatDateTime'

type StorageConfirmAction =
  | { type: 'delete-session'; row: SessionStorageBreakdown }
  | { type: 'prune-all' }

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
  const [confirmAction, setConfirmAction] = useState<StorageConfirmAction | null>(null)
  const [showAllSessions, setShowAllSessions] = useState(false)

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

  const handleDeleteSession = (row: SessionStorageBreakdown) => {
    setConfirmAction({ type: 'delete-session', row })
  }

  const handlePruneAll = () => {
    setConfirmAction({ type: 'prune-all' })
  }

  const handleConfirmAction = () => {
    if (!confirmAction) return
    const action = confirmAction
    setConfirmAction(null)
    if (action.type === 'delete-session') {
      void runAction(
        `delete-${action.row.sessionId}`,
        () => window.api.invoke('storage:delete-session', { sessionId: action.row.sessionId }),
        result => setLastResult(result)
      )
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
  const orphanEntries = report?.orphanEntries ?? []

  const visibleRows = showAllSessions ? sessionRows : sessionRows.slice(0, 10)

  return (
    <SettingsGlassPanel className="storage-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsCard
            title="空间管理"
            description="清理过期的会话快照与磁盘缓存。"
            aside={
              report ? (
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span className="glass-chip">总占用 {formatBytes(report.totalBytes)}</span>
                  {report.orphanBytes > 0 && (
                    <span className="glass-chip">零散数据 {formatBytes(report.orphanBytes)}</span>
                  )}
                </div>
              ) : undefined
            }
          >
            <div className="storage-actions" style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <Button
                label="清理全部过期快照"
                variant="secondary"
                size="sm"
                onClick={handlePruneAll}
                isDisabled={actionId !== null}
              >
                清理全部过期快照
              </Button>
              <Button
                label="立即清理缓存 (GC)"
                variant="secondary"
                size="sm"
                onClick={handleRunGc}
                isDisabled={actionId !== null}
              >
                立即清理缓存 (GC)
              </Button>
            </div>
            {lastResult && lastResult.freedBytes > 0 && (
              <div className="storage-result">
                已释放 {formatBytes(lastResult.freedBytes)}，涉及 {lastResult.affectedSessions} 个会话
              </div>
            )}
            {lastResult && lastResult.freedBytes === 0 && (
              <div className="storage-result storage-result--empty">
                暂无过期内容需要清理
              </div>
            )}
          </SettingsCard>

          <SettingsCard
            title="会话占用明细"
            description={sessionRows.length > 0 ? (showAllSessions ? `展示全部 ${sessionRows.length} 个会话` : `当前显示前 10 个会话（共 ${sessionRows.length} 个）`) : "按磁盘空间统计各会话数据。"}
            aside={
              <Button
                label={loading ? "刷新中…" : "刷新"}
                variant="secondary"
                size="sm"
                onClick={() => void load()}
                isDisabled={loading}
              >
                {loading ? "刷新中…" : "刷新"}
              </Button>
            }
          >
            {error && (
              <span className="settings-status settings-status--error">{error}</span>
            )}
            {sessionRows.length === 0 && orphanEntries.length === 0 ? (
              <span className="settings-help">暂无可显示的会话数据。</span>
            ) : (
              <>
                {sessionRows.length > 0 && (
                  <div className="storage-table">
                    <div className="storage-table__header">
                      <span className="storage-table__cell">会话 / 工作区 / 最近更新</span>
                      <span className="storage-table__cell storage-table__cell--right">消息历史</span>
                      <span className="storage-table__cell storage-table__cell--right">快照</span>
                      <span className="storage-table__cell storage-table__cell--right">产物</span>
                      <span className="storage-table__cell storage-table__cell--right">合计</span>
                      <span className="storage-table__cell storage-table__cell--actions">操作</span>
                    </div>
                    {visibleRows.map(row => (
                      <SessionStorageRow
                        key={row.sessionId}
                        row={row}
                        isBusy={actionId !== null}
                        onPrune={() => handlePruneSession(row.sessionId)}
                        onDelete={() => handleDeleteSession(row)}
                      />
                    ))}
                    {sessionRows.length > 10 && (
                      <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 4px" }}>
                        <Button
                          label={showAllSessions ? "收起会话明细" : `展开剩余 ${sessionRows.length - 10} 个会话`}
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllSessions(!showAllSessions)}
                        >
                          {showAllSessions ? "收起会话明细" : `展开剩余 ${sessionRows.length - 10} 个会话（共 ${sessionRows.length} 个）`}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {orphanEntries.length > 0 && (
                  <div className="storage-orphan-list" aria-label="无对应会话的数据">
                    <div className="storage-orphan-list__title">系统存储数据</div>
                    {orphanEntries.map(entry => (
                      <div
                        className={`storage-orphan-list__item storage-orphan-list__item--${entry.kind}`}
                        key={entry.relativePath}
                      >
                        <span>{entry.kind === "system" ? "系统数据" : "孤立数据"}</span>
                        <span title={entry.relativePath}>{entry.relativePath}</span>
                        <span>{formatBytes(entry.bytes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </SettingsCard>
        </SettingsPage>
      </div>
      {confirmAction && (
        <Dialog
          isOpen
          purpose="form"
          className="glass-dialog"
          width="min(480px, calc(100vw - 32px))"
          aria-labelledby="storage-confirm-title"
          onOpenChange={open => {
            if (!open) setConfirmAction(null)
          }}
        >
          <h3 id="storage-confirm-title">
            {confirmAction.type === "delete-session" ? "彻底删除会话？" : "清理所有过期快照？"}
          </h3>
          <p>
            {confirmAction.type === "delete-session"
              ? `将永久删除「${confirmAction.row.title ?? confirmAction.row.sessionId}」的消息与产物，操作无法恢复。`
              : "被清理的快照将无法再用于回退恢复。"}
          </p>
          <div className="storage-confirm__actions">
            <Button
              label="取消"
              variant="secondary"
              size="sm"
              onClick={() => setConfirmAction(null)}
            >
              取消
            </Button>
            <Button
              label={confirmAction.type === "delete-session" ? "彻底删除" : "清理快照"}
              variant={confirmAction.type === "delete-session" ? "destructive" : "primary"}
              size="sm"
              onClick={handleConfirmAction}
            >
              {confirmAction.type === "delete-session" ? "彻底删除" : "清理快照"}
            </Button>
          </div>
        </Dialog>
      )}
    </SettingsGlassPanel>
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
      <span className="storage-table__cell storage-table__cell--session">
        <strong>{row.title ?? '未命名会话'}</strong>
        <span title={row.workspaceRoot ?? undefined}>{row.workspaceRoot ?? '未知工作区'}</span>
        <span className="storage-table__cell--secondary" title={row.sessionId}>
          ID：{row.sessionId}
        </span>
        <time>{row.updatedAt === null ? '更新时间未知' : formatSettingsDateTime(row.updatedAt)}</time>
      </span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.historyBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.checkpointsBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right">{formatBytes(row.artifactsBytes)}</span>
      <span className="storage-table__cell storage-table__cell--right storage-table__cell--total">
        {formatBytes(row.totalBytes)}
      </span>
      <span className="storage-table__cell storage-table__cell--actions">
        <Button
          label="清理"
          variant="ghost"
          size="sm"
          className="storage-table__action"
          onClick={onPrune}
          isDisabled={isBusy}
          tooltip="清理该会话的过期 checkpoint 快照"
        >
          清理
        </Button>
        <Button
          label="删除"
          variant="destructive"
          size="sm"
          className="storage-table__action storage-table__action--danger"
          onClick={onDelete}
          isDisabled={isBusy}
          tooltip="彻底删除该会话及其所有数据"
        >
          删除
        </Button>
      </span>
    </div>
  )
}
