/**
 * 编排进度面板：渲染 phase / tasks / stats / global_check / 失败诊断
 * 挂载于 ChatPanel composer dock；默认折叠为一行细条，无活跃 state 时不渲染。
 */
import React, { useState } from 'react'
import { useComposeStore } from './useComposeStore'
import { useAgentStore } from '../../stores/useAgentStore'
import type { ComposeTaskView } from './types'
import './ComposeProgressPanel.css'

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  in_progress: '🔄',
  done: '✅',
  skipped: '⏭️',
  failed: '❌'
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待开始',
  in_progress: '进行中',
  done: '完成',
  skipped: '跳过',
  failed: '失败',
  running: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断'
}

function statusIcon(status: string): string {
  return STATUS_ICON[status] ?? '•'
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

function taskNote(task: ComposeTaskView): string {
  if (task.status === 'done' && task.verify) {
    return `验收 ${task.verify.pass}/${task.verify.pass + task.verify.fail} 通过`
  }
  if ((task.status === 'skipped' || task.status === 'failed') && task.failure?.summary) {
    return task.failure.summary
  }
  if (task.status === 'in_progress') return '执行中…'
  return '—'
}

/** label 已含「阶段」前缀时不再叠 meta「阶段」标签 */
function phaseLabelAlreadyPrefixed(label: string): boolean {
  return label.includes('阶段')
}

const FailureDetail: React.FC<{ task: ComposeTaskView }> = ({ task }) => {
  const f = task.failure
  if (!f) return null
  return (
    <div className="compose-panel__failure" role="region" aria-label={`${task.id} 失败诊断`}>
      <div className="compose-panel__failure-title">
        {statusIcon(task.status)} {task.id}「{task.title}」为什么
        {task.status === 'skipped' ? '跳过' : '失败'}
      </div>
      <dl className="compose-panel__failure-dl">
        <dt>现象</dt>
        <dd>{f.summary}</dd>
        {f.evidence && (
          <>
            <dt>证据</dt>
            <dd className="compose-panel__mono">{f.evidence}</dd>
          </>
        )}
        {f.root_cause_guess && (
          <>
            <dt>根因猜测</dt>
            <dd>{f.root_cause_guess}</dd>
          </>
        )}
        {f.tried && f.tried.length > 0 && (
          <>
            <dt>已尝试</dt>
            <dd>
              <ul>
                {f.tried.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {f.next_steps && f.next_steps.length > 0 && (
          <>
            <dt>建议下一步</dt>
            <dd>
              <ul>
                {f.next_steps.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {f.reason && (
          <>
            <dt>原因码</dt>
            <dd className="compose-panel__mono">{f.reason}</dd>
          </>
        )}
      </dl>
    </div>
  )
}

const TaskRow: React.FC<{
  task: ComposeTaskView
  expanded: boolean
  onToggle: () => void
}> = ({ task, expanded, onToggle }) => {
  const hasFailure = !!(task.failure && (task.status === 'skipped' || task.status === 'failed'))
  return (
    <>
      <tr
        className={`compose-panel__row compose-panel__row--${task.status}${hasFailure ? ' compose-panel__row--clickable' : ''}`}
        onClick={hasFailure ? onToggle : undefined}
        aria-expanded={hasFailure ? expanded : undefined}
      >
        <td className="compose-panel__td-task">
          <span className="compose-panel__task-id">{task.id}</span>
          <span className="compose-panel__task-title">{task.title}</span>
        </td>
        <td className="compose-panel__td-status">
          {statusIcon(task.status)} {statusLabel(String(task.status))}
          {hasFailure && (
            <span className="compose-panel__expand-hint" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </td>
        <td className="compose-panel__td-note">{taskNote(task)}</td>
      </tr>
      {hasFailure && expanded && (
        <tr className="compose-panel__row-detail">
          <td colSpan={3}>
            <FailureDetail task={task} />
          </td>
        </tr>
      )}
    </>
  )
}

export const ComposeProgressPanel: React.FC = () => {
  const state = useComposeStore((s) => s.state)
  const runId = useComposeStore((s) => s.runId)
  const viewStatus = useComposeStore((s) => s.viewStatus)
  const dismiss = useComposeStore((s) => s.dismiss)
  const cancelExecution = useAgentStore((s) => s.cancelExecution)
  // 默认折叠为一行细条（与 TodoPanel dock 一致）
  const [collapsed, setCollapsed] = useState(true)
  /** 用户手动收起的任务 id（skipped/failed 默认展开） */
  const [userClosed, setUserClosed] = useState<Set<string>>(new Set())
  /** 用户手动展开的任务 id（非默认展开的） */
  const [userOpened, setUserOpened] = useState<Set<string>>(new Set())

  if (!state) return null

  const stats = state.stats ?? {
    total: state.tasks?.length ?? 0,
    done: state.tasks?.filter((t) => t.status === 'done').length ?? 0,
    skipped: state.tasks?.filter((t) => t.status === 'skipped').length ?? 0,
    failed: state.tasks?.filter((t) => t.status === 'failed').length ?? 0
  }

  const tasks = state.tasks ?? []
  const runStatus = String(state.run.status)
  // viewStatus 优先：崩溃残留 running 时展示「已中断」
  const displayStatus = viewStatus === 'interrupted' ? 'interrupted' : runStatus
  const isActive = displayStatus === 'running'
  const isTerminal =
    displayStatus === 'completed' ||
    displayStatus === 'failed' ||
    displayStatus === 'cancelled' ||
    displayStatus === 'interrupted'

  const phaseText = state.phase?.label || state.phase?.current || ''

  // skipped/failed 默认展开诊断；用户可点击收起/再展开
  const isExpanded = (task: ComposeTaskView): boolean => {
    if (userClosed.has(task.id)) return false
    if (userOpened.has(task.id)) return true
    return (
      (task.status === 'skipped' || task.status === 'failed') && !!task.failure
    )
  }

  const handleToggle = (task: ComposeTaskView): void => {
    const open = isExpanded(task)
    if (open) {
      setUserClosed((prev) => new Set(prev).add(task.id))
      setUserOpened((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    } else {
      setUserClosed((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
      setUserOpened((prev) => new Set(prev).add(task.id))
    }
  }

  /** 停止：先走 AgentLoop 取消，再幂等 compose:cancel 兜底 */
  const handleStop = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void cancelExecution()
    if (runId) {
      void window.api.invoke('compose:cancel', { runId }).catch(() => undefined)
    }
  }

  const handleDismiss = (e: React.MouseEvent): void => {
    e.stopPropagation()
    dismiss()
  }

  const gc = state.global_check

  // header 右侧摘要：无任务时显示阶段名，避免「0/0 完成」
  const progressSummary =
    stats.total === 0
      ? phaseText || '编排中'
      : `${stats.done}/${stats.total} 完成${stats.skipped > 0 ? ` · ${stats.skipped} 跳过` : ''}${stats.failed > 0 ? ` · ${stats.failed} 失败` : ''}`

  return (
    <div className="compose-dock">
      <div
        className={`compose-panel${isActive ? ' compose-panel--active' : ''}`}
        data-status={displayStatus}
        data-expanded={!collapsed}
      >
        <div className="compose-panel__header-row">
          <button
            type="button"
            className="compose-panel__header"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            <span className="compose-panel__caret" data-collapsed={collapsed} aria-hidden="true">
              ▾
            </span>
            <span className="compose-panel__badge" data-status={displayStatus}>
              {statusLabel(displayStatus)}
            </span>
            {phaseText && (
              <span className="compose-panel__phase-inline" title={phaseText}>
                {phaseText}
              </span>
            )}
            <span
              className="compose-panel__progress"
              aria-label={stats.total > 0 ? `完成 ${stats.done} / ${stats.total}` : phaseText || '编排中'}
            >
              {progressSummary}
            </span>
          </button>
          {isActive && (
            <button
              type="button"
              className="compose-panel__action compose-panel__action--stop"
              onClick={handleStop}
              title="停止编排"
            >
              停止
            </button>
          )}
          {isTerminal && (
            <button
              type="button"
              className="compose-panel__action compose-panel__action--dismiss"
              onClick={handleDismiss}
              title="关闭"
              aria-label="关闭编排面板"
            >
              ×
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="compose-panel__body">
            <div className="compose-panel__meta">
              <div>
                <span className="compose-panel__meta-label">命令</span>
                <span>{state.run.command}</span>
              </div>
              {state.phase && (
                <div>
                  {!phaseLabelAlreadyPrefixed(state.phase.label || state.phase.current) && (
                    <span className="compose-panel__meta-label">阶段</span>
                  )}
                  <span>{state.phase.label || state.phase.current}</span>
                </div>
              )}
            </div>

            {tasks.length > 0 && (
              <table className="compose-panel__table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      expanded={isExpanded(task)}
                      onToggle={() => handleToggle(task)}
                    />
                  ))}
                </tbody>
              </table>
            )}

            {gc && (gc.test || gc.build || gc.lint) && (
              <div className="compose-panel__checks">
                <span className="compose-panel__meta-label">全量检查</span>
                {gc.test && (
                  <span data-status={gc.test.status}>
                    test: {gc.test.status}
                  </span>
                )}
                {gc.build && (
                  <span data-status={gc.build.status}>
                    build: {gc.build.status}
                  </span>
                )}
                {gc.lint && (
                  <span data-status={gc.lint.status}>
                    lint: {gc.lint.status}
                  </span>
                )}
              </div>
            )}

            {state.artifacts && (state.artifacts.spec || state.artifacts.plan || state.artifacts.report) && (
              <div className="compose-panel__artifacts">
                <span className="compose-panel__meta-label">产物</span>
                <ul>
                  {state.artifacts.spec && <li>设计：{state.artifacts.spec}</li>}
                  {state.artifacts.plan && <li>计划：{state.artifacts.plan}</li>}
                  {state.artifacts.report && <li>报告：{state.artifacts.report}</li>}
                </ul>
              </div>
            )}

            {state.auto_decisions && state.auto_decisions.length > 0 && (
              <details className="compose-panel__decisions">
                <summary>自动决策（{state.auto_decisions.length}）</summary>
                <ol>
                  {state.auto_decisions.map((d, i) => (
                    <li key={i}>
                      <strong>{d.decision}</strong>
                      {d.reason ? ` — ${d.reason}` : ''}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
