/**
 * 学习专属文案的唯一来源；用户消息展示文本由主进程 LearningDelivery 生成。
 * 共用的聊天过程与生成提示直接复用聊天组件。
 */
import type { LearningCommandReceipt } from '../../../shared/learning/command'
import type { LearningNavDimensionId } from '../../../shared/learning/navigation'
import type { LearningAssessVerdict } from '../../../shared/learning/rubric'
import type {
  LearningBuildFailureReason,
  LearningBuildStage,
  LearningNodeProgressView,
  LearningQuestionView
} from '../../../shared/learning/surface'

// ── 学习主区 ──────────────────────────────────────────────

/** 空状态标题；项目名取工作区路径的最后一段。 */
export function learningEmptyStateTitle(workspaceRoot: string | null | undefined): string {
  const segments = (workspaceRoot ?? '').split(/[\\/]+/).filter(Boolean)
  const name = segments.length > 0 ? segments[segments.length - 1] : '这个项目'
  return `想搞懂 ${name} 的哪一部分？`
}

export const LEARNING_COMPOSER_LABEL = '学习提问'
export const LEARNING_COMPOSER_PLACEHOLDER = '问任何关于这个项目的问题'
export const LEARNING_COMPOSER_PLACEHOLDER_GENERATING = '回答中…'
export const LEARNING_SEND_LABEL = '发送'
export const LEARNING_STOP_LABEL = '中断生成'
export const LEARNING_CONVERSATION_LABEL = '学习对话'
export const LEARNING_MESSAGES_LABEL = '学习消息'
export const LEARNING_COPY_MESSAGE = '复制此消息'
export const LEARNING_MESSAGE_COPIED = '已复制'
export const LEARNING_SCROLL_TO_BOTTOM = '回到底部'

export const LEARNING_DOCK_LABEL = '当前问题'
export const LEARNING_DOCK_EYEBROW = '想一想'
export const LEARNING_ANSWER_LABEL = '回答'
export const LEARNING_ANSWER_PLACEHOLDER = '说说你的理解'
export const LEARNING_DOCK_SUBMIT = '提交'
export const LEARNING_DOCK_HINT = '提示'
export const LEARNING_DOCK_EXPLAIN = '直接讲'
export const LEARNING_DOCK_SKIP = '跳过'

/** 无大纲时的三条起点建议，全部作为普通消息发送。 */
export const LEARNING_START_SUGGESTIONS = [
  '帮我挑个入门的起点',
  '这个项目解决什么问题？',
  '从启动开始讲它怎么跑起来'
] as const

/** 有大纲时第一条建议改为直接选主题。 */
export function learningTopicSuggestion(topicTitle: string): string {
  return `从「${topicTitle}」开始`
}

export function learningTopicDivider(topicTitle: string): string {
  return `开始学习 · ${topicTitle}`
}

export const LEARNING_TURN_INTERRUPTED = '已停止'
export const LEARNING_TURN_ERROR = '这次回答出错了'

export const LEARNING_READ_FAILURE_TITLE = '学习记录读取失败'
export const LEARNING_RETRY_LABEL = '重试'

/** 命令被拒的回执失败形态；code 直接来自共享契约，避免第二份枚举。 */
export type LearningCommandRejection = Extract<LearningCommandReceipt, { ok: false }>

const COMMAND_REJECTION_COPY: Record<LearningCommandRejection['code'], string> = {
  busy: '上一条还在回答，等它结束或先停止',
  stale: '内容已更新，请再试一次',
  // invalid 的 message 由主进程保证是人话，直接透出
  invalid: '',
  unavailable: '学习数据暂时不可用，重启应用后再试'
}

export function learningCommandRejectionCopy(rejection: LearningCommandRejection): string {
  return rejection.code === 'invalid' ? rejection.message : COMMAND_REJECTION_COPY[rejection.code]
}

// ── 题目行 ────────────────────────────────────────────────

export type LearningQuestionRowIcon = 'check' | 'refresh' | 'circle' | 'help' | 'skip' | 'spinner'

export interface LearningQuestionRowStatus {
  /** null 表示没有可显示的提示（例如已回答但还没有点评），只画中性图标。 */
  readonly label: string | null
  readonly tone: 'success' | 'warning' | 'muted'
  readonly icon: LearningQuestionRowIcon
  readonly spin?: boolean
}

/**
 * 题目行状态图标与提示的唯一映射：state 优先于 verdict，
 * awaiting_answer 返回 null（该题只出现在停靠面板，不画题目行）。
 */
export function learningQuestionRowStatus(
  question: LearningQuestionView,
  isRunning: boolean
): LearningQuestionRowStatus | null {
  switch (question.state) {
    case 'awaiting_answer':
      return null
    case 'skipped':
      return { label: '已跳过', tone: 'muted', icon: 'skip' }
    case 'superseded':
      return { label: '已换题', tone: 'muted', icon: 'circle' }
    case 'answer_pending':
      return isRunning
        ? { label: '评估中', tone: 'muted', icon: 'spinner', spin: true }
        : { label: '评估没完成', tone: 'warning', icon: 'refresh' }
    case 'answered':
      break
  }
  const assessment = question.assessment
  if (!assessment) return { label: null, tone: 'muted', icon: 'circle' }
  if (assessment.disputed) return { label: '等待复核', tone: 'warning', icon: 'help' }
  return LEARNING_VERDICT_STATUS[assessment.verdict]
}

const LEARNING_VERDICT_STATUS: Record<LearningAssessVerdict, LearningQuestionRowStatus> = {
  understanding_observed: { label: '理解到位', tone: 'success', icon: 'check' },
  needs_clarification: { label: '还差一点', tone: 'warning', icon: 'refresh' },
  inconclusive: { label: '没判断出来', tone: 'muted', icon: 'circle' }
}

export const LEARNING_DISPUTE_LABEL = '不认同'
export const LEARNING_DISPUTE_PLACEHOLDER = '哪里判断得不对？（可不填）'
export const LEARNING_DISPUTE_SEND = '发送'
export const LEARNING_DISPUTE_CANCEL = '取消'

// ── 大纲页 ────────────────────────────────────────────────

export const LEARNING_OUTLINE_LOADING = '加载中…'
export const LEARNING_OUTLINE_MENU_LABEL = '大纲操作'
export const LEARNING_OUTLINE_EMPTY_TITLE = '还没有大纲'
export const LEARNING_OUTLINE_GENERATE = '生成大纲'
export const LEARNING_OUTLINE_REGENERATE = '重新生成大纲'
export const LEARNING_OUTLINE_GENERATE_HINT = '读取部分代码，调用 1–2 次模型'
export const LEARNING_OUTLINE_QUEUED = '等当前任务结束后开始'
export const LEARNING_OUTLINE_CANCEL = '取消'
export const LEARNING_OUTLINE_RESUME = '继续'
export const LEARNING_OUTLINE_PAUSED_AUTO = '已暂停，当前任务结束后继续'
export const LEARNING_OUTLINE_PAUSED = '已暂停'
export const LEARNING_OUTLINE_STAGES_LABEL = '生成进度'
export function learningOutlineToggleLabel(title: string, expanded: boolean): string {
  return `${expanded ? '收起' : '展开'}${title}`
}
export const LEARNING_GO_TO_SETTINGS = '去设置'

/** 生成中三步指示的顺序与文案。 */
export const LEARNING_BUILD_STAGES: ReadonlyArray<{ readonly stage: LearningBuildStage; readonly label: string }> = [
  { stage: 'collecting', label: '扫描代码' },
  { stage: 'analyzing', label: '整理大纲' },
  { stage: 'validating', label: '核对出处' }
]

export interface LearningBuildFailureCopy {
  readonly title: string
  readonly action: 'settings' | 'retry' | null
}

export function learningBuildFailureCopy(
  reason: LearningBuildFailureReason,
  detail?: string
): LearningBuildFailureCopy {
  switch (reason) {
    case 'no_model':
      return { title: '还没有可用的模型', action: 'settings' }
    case 'context_too_small':
      return { title: '当前模型的上下文太小，换个模型再试', action: 'retry' }
    case 'invalid_output':
      return { title: '这次生成的大纲不完整，再试一次', action: 'retry' }
    case 'source_changed':
      return { title: '生成时代码有改动，再试一次', action: 'retry' }
    case 'provider_error':
      return { title: detail ? `模型请求失败：${detail}` : '模型请求失败', action: 'retry' }
    case 'busy_other_project':
      return { title: '另一个项目正在生成大纲，稍后再试', action: 'retry' }
    case 'storage_unavailable':
      return { title: '学习数据读取失败，重启应用后再试', action: null }
  }
}

export const LEARNING_OUTLINE_DIMENSION_TITLES: Record<LearningNavDimensionId | 'other', string> = {
  project_purpose: '项目用途',
  startup_runtime: '启动与运行',
  module_roles: '模块职责',
  key_user_flows: '关键用户流程',
  data_and_state: '数据与状态',
  design_tradeoffs: '设计与取舍',
  other: '其他'
}

/** 条目前置圆点：个人进度。none 表示还没有记录。 */
export type LearningNodeProgressState = LearningNodeProgressView['state'] | 'none'

export const LEARNING_NODE_PROGRESS_COPY: Record<LearningNodeProgressState, string> = {
  none: '还没学',
  explained: '讲过',
  understanding_observed: '理解到位',
  needs_clarification: '还差一点',
  pending_review: '等待复核'
}

/** 条目尾部标记：只在异常时出现。≈ 表示部分推断，琥珀点表示代码已改动。 */
export const LEARNING_MARK_PARTIAL_TOOLTIP = '部分内容是推断'
export const LEARNING_MARK_STALE_TOOLTIP = '代码已改动'

// ── 主题详情 ──────────────────────────────────────────────

export const LEARNING_DETAIL_MENU_LABEL = '主题操作'
export const LEARNING_DETAIL_BACK = '返回大纲'
export const LEARNING_DETAIL_START = '从这里开始学'
export const LEARNING_SOURCE_SNIPPET_LABEL = '代码片段'
export const LEARNING_DETAIL_EDIT_IN_DEV = '在开发会话中修改'
export const LEARNING_INFERENCE_TOOLTIP = '根据代码推断'
/** 主题尚无已发布内容 / 内容解析失败时的兜底文案。 */
export const LEARNING_DETAIL_NO_MATERIAL = '这个主题还没有内容'
export const LEARNING_DETAIL_BODY_INVALID = '这个主题的内容有问题，重新生成大纲试试'

export function learningEditInDevPrefill(topicTitle: string, filePath: string, startLine: number): string {
  return `修改「${topicTitle}」相关代码（${filePath}:${startLine}）：`
}

export function learningEditInDevPrefillWithoutSource(topicTitle: string): string {
  return `修改「${topicTitle}」相关代码：`
}

export const LEARNING_SOURCE_CHANGED = '代码已改动'
export const LEARNING_SOURCE_MISSING = '找不到这段代码了'
export const LEARNING_SOURCE_DENIED = '这个文件不允许读取'

export function learningSourceFailureCopy(failure: {
  readonly reason: 'missing' | 'denied' | 'unavailable'
  readonly message: string
}): string {
  switch (failure.reason) {
    case 'missing':
      return LEARNING_SOURCE_MISSING
    case 'denied':
      return LEARNING_SOURCE_DENIED
    case 'unavailable':
      return failure.message
  }
}
