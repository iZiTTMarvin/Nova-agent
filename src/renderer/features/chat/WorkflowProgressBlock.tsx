/**
 * 编排进度块：聊天流中的醒目状态条。
 *
 * 只做展示，不做逻辑分支——status / detail 的语义由 runtime 决定，
 * 这里仅把它翻译成图标、色带与一句中文说明。
 */
import React from 'react'
import type { WorkflowProgressStatus } from '../../../shared/workflow/types'
import type { RendererWorkflowProgressBlock } from '../../stores/types'
import './WorkflowProgressBlock.css'

/** 阶段英文名 → 中文标签；未收录的阶段直接显示原名 */
const PHASE_LABELS: Record<string, string> = {
  brainstorm: '方案构思',
  plan: '制定计划',
  implement: '编码实现',
  verify: '验证',
  review: '代码审查',
  report: '汇总',
  brief: '提炼问题',
  research: '资料调研',
  synthesize: '综合结论'
}

/** status → 视觉档位。tone 决定色带，icon 决定左侧标识 */
const STATUS_STYLE: Record<
  WorkflowProgressStatus,
  { tone: 'active' | 'done' | 'error' | 'info'; icon: string; verb: string }
> = {
  started: { tone: 'active', icon: '▶', verb: '进入' },
  completed: { tone: 'done', icon: '✓', verb: '完成' },
  failed: { tone: 'error', icon: '✗', verb: '失败' },
  task_started: { tone: 'active', icon: '▶', verb: '开始任务' },
  task_complete: { tone: 'done', icon: '✓', verb: '任务完成' },
  task_failed: { tone: 'error', icon: '✗', verb: '任务失败' },
  batch_started: { tone: 'active', icon: '⇉', verb: '并行批次' },
  batch_merge: { tone: 'info', icon: '⇲', verb: '合并批次' },
  info: { tone: 'info', icon: '•', verb: '' }
}

export function formatPhaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase
}

/** 拼装进度块正文。detail 缺省时只显示阶段与动作。 */
export function formatProgressText(block: RendererWorkflowProgressBlock): string {
  const style = STATUS_STYLE[block.status] ?? STATUS_STYLE.info
  const phase = formatPhaseLabel(block.phase)
  const detail = block.detail
  const parts: string[] = []

  if (detail?.taskName) parts.push(detail.taskName)
  else if (detail?.taskId) parts.push(detail.taskId)
  if (detail?.batchIndex !== undefined) {
    const size = detail.batchSize !== undefined ? ` / ${detail.batchSize} 个任务` : ''
    parts.push(`第 ${detail.batchIndex} 批${size}`)
  }
  if (detail?.message) parts.push(detail.message)

  const head = style.verb ? `${style.verb} ${phase}` : phase
  return parts.length > 0 ? `${head} — ${parts.join('，')}` : head
}

export const WorkflowProgressBlock: React.FC<{
  block: RendererWorkflowProgressBlock
}> = ({ block }) => {
  const style = STATUS_STYLE[block.status] ?? STATUS_STYLE.info
  return (
    <div
      className={`workflow-progress workflow-progress--${style.tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="workflow-progress__bar" aria-hidden="true" />
      <span className="workflow-progress__icon" aria-hidden="true">
        {style.icon}
      </span>
      <span className="workflow-progress__content">
        <span className="workflow-progress__text">{formatProgressText(block)}</span>
        {block.activity ? (
          // 活动行：运行中展示"正在做什么"，失败时展示最后一条诊断
          <span className="workflow-progress__activity" title={block.activity}>
            {block.activity}
          </span>
        ) : null}
      </span>
    </div>
  )
}
