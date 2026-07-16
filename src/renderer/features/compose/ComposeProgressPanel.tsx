/**
 * 编排进度面板：渲染 phase / tasks / stats / global_check / 失败诊断
 * interrupted 提供：继续 / 从步骤重跑 / 查看将跳过 / 回滚 / 新建分析
 */
import React, { useState } from 'react'
import { useComposeStore } from './useComposeStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { useRunStore } from '../../stores/useRunStore'
import type { RunSnapshot } from '../../../runtime/run/types'
import type { ComposeTaskView } from './types'
import './ComposeProgressPanel.css'

const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  in_progress: '🔄',
  done: '✅',
  unverified: '⚠️',
  skipped: '⏭️',
  failed: '❌'
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待开始',
  in_progress: '进行中',
  done: '完成',
  unverified: '未定向验证',
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
  const xforgeSnapshot = useRunStore((s) => s.snapshot)
  const state = useComposeStore((s) => s.state)
  const runId = useComposeStore((s) => s.runId)
  const viewStatus = useComposeStore((s) => s.viewStatus)
  const dismiss = useComposeStore((s) => s.dismiss)
  const resumeRun = useComposeStore((s) => s.resumeRun)
  const inspectResume = useComposeStore((s) => s.inspectResume)
  const rollbackRun = useComposeStore((s) => s.rollbackRun)
  const newAnalysisRun = useComposeStore((s) => s.newAnalysisRun)
  const resumePreview = useComposeStore((s) => s.resumePreview)
  const busyAction = useComposeStore((s) => s.busyAction)
  const cancelExecution = useAgentStore((s) => s.cancelExecution)
  const [collapsed, setCollapsed] = useState(true)
  const [userClosed, setUserClosed] = useState<Set<string>>(new Set())
  const [userOpened, setUserOpened] = useState<Set<string>>(new Set())
  const [showPreview, setShowPreview] = useState(false)
  const [rerunStepId, setRerunStepId] = useState('')
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  if (xforgeSnapshot?.kind === 'xforge' && xforgeSnapshot.xforge) {
    return <XForgeProgressView snapshot={xforgeSnapshot} onCancel={cancelExecution} />
  }

  if (!state) return null

  const stats = state.stats ?? {
    total: state.tasks?.length ?? 0,
    done: state.tasks?.filter((t) => t.status === 'done').length ?? 0,
    skipped: state.tasks?.filter((t) => t.status === 'skipped').length ?? 0,
    failed: state.tasks?.filter((t) => t.status === 'failed').length ?? 0
  }

  const tasks = state.tasks ?? []
  const runStatus = String(state.run.status)
  const displayStatus = viewStatus === 'interrupted' ? 'interrupted' : runStatus
  const isActive = displayStatus === 'running'
  const isInterrupted = displayStatus === 'interrupted'
  const isTerminal =
    displayStatus === 'completed' ||
    displayStatus === 'failed' ||
    displayStatus === 'cancelled' ||
    displayStatus === 'interrupted'

  const phaseText = state.phase?.label || state.phase?.current || ''
  const isV2Preview = resumePreview?.engine === 'v2'
  // v2 完成前：按钮称「重新执行并复用结果」；v2 有 step 后称「从未完成步骤继续」
  const continueLabel = isV2Preview
    ? '从未完成步骤继续'
    : '重新执行并复用结果'

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

  const handleContinue = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setActionMsg(null)
    await resumeRun()
  }

  const handleRerunFrom = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!rerunStepId.trim()) {
      setActionMsg('请先填写要重跑的步骤 ID')
      return
    }
    setActionMsg(null)
    await resumeRun({ rerunFromStepId: rerunStepId.trim() })
  }

  const handleInspect = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setActionMsg(null)
    const plan = await inspectResume(rerunStepId.trim() || undefined)
    setShowPreview(true)
    if (!plan) setActionMsg('无法加载步骤预览')
  }

  const handleRollback = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setActionMsg(null)
    const result = await rollbackRun()
    if (result.ok) {
      setActionMsg('已回滚到编排开始时的 git baseline')
    } else {
      setActionMsg(result.error ?? '回滚失败')
    }
  }

  const handleNewAnalysis = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setActionMsg(null)
    await newAnalysisRun()
  }

  const gc = state.global_check
  const progressSummary =
    stats.total === 0
      ? phaseText || '编排中'
      : `${stats.done}/${stats.total} 完成${stats.skipped > 0 ? ` · ${stats.skipped} 跳过` : ''}${stats.failed > 0 ? ` · ${stats.failed} 失败` : ''}`

  const busy = busyAction !== null

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

            {/* interrupted：继续 / 查看 / 回滚 三路径 */}
            {isInterrupted && (
              <div className="compose-panel__resume" role="region" aria-label="中断恢复操作">
                <div className="compose-panel__resume-title">编排已中断，可选择：</div>
                <div className="compose-panel__resume-actions">
                  <button
                    type="button"
                    className="compose-panel__btn compose-panel__btn--primary"
                    disabled={busy}
                    onClick={handleContinue}
                    title={continueLabel}
                  >
                    {busyAction === 'resume' ? '继续中…' : continueLabel}
                  </button>
                  <button
                    type="button"
                    className="compose-panel__btn"
                    disabled={busy}
                    onClick={handleInspect}
                  >
                    {busyAction === 'inspect' ? '加载中…' : '查看将跳过/重跑'}
                  </button>
                  <button
                    type="button"
                    className="compose-panel__btn compose-panel__btn--danger"
                    disabled={busy}
                    onClick={handleRollback}
                  >
                    {busyAction === 'rollback' ? '回滚中…' : '回滚文件修改'}
                  </button>
                  <button
                    type="button"
                    className="compose-panel__btn"
                    disabled={busy}
                    onClick={handleNewAnalysis}
                  >
                    {busyAction === 'new' ? '启动中…' : '新建分析'}
                  </button>
                </div>
                <div className="compose-panel__rerun-row">
                  <label className="compose-panel__meta-label" htmlFor="compose-rerun-step">
                    从步骤后重跑
                  </label>
                  <input
                    id="compose-rerun-step"
                    className="compose-panel__input"
                    value={rerunStepId}
                    onChange={(e) => setRerunStepId(e.target.value)}
                    placeholder="stepId，如 plan:write-plan"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="compose-panel__btn"
                    disabled={busy || !rerunStepId.trim()}
                    onClick={handleRerunFrom}
                  >
                    重跑
                  </button>
                </div>
                {actionMsg && (
                  <div className="compose-panel__action-msg" role="status">
                    {actionMsg}
                  </div>
                )}
                {showPreview && resumePreview && (
                  <div className="compose-panel__preview">
                    <div className="compose-panel__meta-label">
                      引擎 {resumePreview.engine}
                      {resumePreview.engine === 'v1'
                        ? '（将重新执行并复用 journal 结果）'
                        : ''}
                    </div>
                    {resumePreview.skip.length > 0 && (
                      <details open>
                        <summary>将跳过（{resumePreview.skip.length}）</summary>
                        <ul>
                          {resumePreview.skip.map((s) => (
                            <li key={s.stepId}>
                              <code>{s.stepId}</code> · {s.kind}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {resumePreview.run.length > 0 && (
                      <details open>
                        <summary>将执行（{resumePreview.run.length}）</summary>
                        <ul>
                          {resumePreview.run.map((s) => (
                            <li key={s.stepId}>
                              <code>{s.stepId}</code> · {s.kind} · {s.status}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {resumePreview.blocked.length > 0 && (
                      <details>
                        <summary>受阻（{resumePreview.blocked.length}）</summary>
                        <ul>
                          {resumePreview.blocked.map((s) => (
                            <li key={s.stepId}>
                              <code>{s.stepId}</code>
                              {s.error ? ` — ${s.error}` : ''}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}

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

const STAGE_LABELS: Record<string, string> = {
  resolve: '识别起点',
  brainstorm: '需求探索',
  plan: '实施计划',
  scope_check: 'Scope Check',
  implement: '实施',
  test: 'Test Gate',
  review: '隔离 Review',
  fix: '根因修复',
  report: '最终报告',
  waiting_user: '等待用户',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

const XForgeProgressView: React.FC<{
  snapshot: RunSnapshot
  onCancel: (runId?: string) => Promise<void>
}> = ({ snapshot, onCancel }) => {
  const state = snapshot.xforge!
  const testVerdict = state.testEvidence
    ? state.testEvidence.passed ? '通过' : '失败'
    : '未运行'
  const blocking = state.reviewFindings.filter(
    finding => finding.severity === 'critical' || finding.severity === 'high'
  ).length
  return (
    <section className="compose-panel" aria-label="XForge 运行进度">
      <header className="compose-panel__header">
        <div>
          <strong>XForge · {STAGE_LABELS[state.currentStage] ?? state.currentStage}</strong>
          <div className="compose-panel__mono">runId: {snapshot.runId}</div>
        </div>
        {!['completed', 'failed', 'cancelled'].includes(state.currentStage) && (
          <button className="compose-panel__btn" onClick={() => void onCancel(snapshot.runId)}>停止</button>
        )}
      </header>
      <div className="compose-panel__meta">
        <span>已完成：{state.completedStages.map(stage => STAGE_LABELS[stage] ?? stage).join('、') || '—'}</span>
        <span>已跳过：{state.skippedStages.map(stage => STAGE_LABELS[stage] ?? stage).join('、') || '—'}</span>
        <span>Test Gate：{testVerdict}</span>
        <span>Blocking：{blocking}</span>
      </div>
      <div className="compose-panel__meta">
        <span>Scope 修正 {state.scopeCorrectionUsed}/2</span>
        <span>Test-Fix {state.deliveryTestFixUsed}/3</span>
        <span>Review-Fix {state.reviewRemediationUsed}/2</span>
        {state.reviewOnly && <span>Review Only</span>}
      </div>
      {state.currentStage === 'waiting_user' && (
        <div className="compose-panel__failure" role="status">
          <strong>安全暂停</strong>
          <div>{state.waitingReason ?? '需要你的输入'}</div>
          <div>回复消息后从 {STAGE_LABELS[state.resumeTarget ?? ''] ?? state.resumeTarget ?? '当前阶段'} 继续。</div>
        </div>
      )}
      {state.tasks.length > 0 && (
        <table className="compose-panel__table">
          <thead><tr><th>任务</th><th>状态</th><th>尝试</th></tr></thead>
          <tbody>
            {state.tasks.map(task => (
              <tr key={task.id} className={`compose-panel__row compose-panel__row--${task.status}`}>
                <td className="compose-panel__td-task"><span className="compose-panel__task-id">{task.id}</span> {task.title}</td>
                <td>{statusIcon(task.status)} {statusLabel(task.status)}</td>
                <td>{task.attempts}/3{task.failureReason ? ` · ${task.failureReason}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
