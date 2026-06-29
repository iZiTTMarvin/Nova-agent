/**
 * askQuestion 工具的共享类型定义
 *
 * 涉及三层：
 * - runtime 层：工具 execute() 校验入参、格式化输出
 * - IPC 层：事件 payload 和命令参数传递
 * - renderer 层：store 状态和 UI 组件
 *
 * 三层共用同一套类型，避免重复定义导致字段漂移。
 */

/** 单个选项 */
export interface AskQuestionOption {
  /** 选项显示文本 */
  label: string
  /** 选项说明（可选，UI 显示在 label 下方） */
  description?: string
  /** 是否为推荐项；UI 在该选项 label 旁渲染 "(Recommended)" */
  recommended?: boolean
}

/** 单个问题 */
export interface AskQuestionItem {
  /** 问题正文 */
  question: string
  /** 问题上方的小标题/上下文（可选，如 "Select a theme"） */
  header?: string
  /** 选项列表（至少 1 个） */
  options: AskQuestionOption[]
  /** 是否允许多选；false/undefined = 单选 */
  multiple?: boolean
  /**
   * 是否允许用户自定义输入。
   * 为 true 时 UI 在选项列表底部追加 "Type your own answer" 输入框。
   * 默认 true（参照 kilocode）。
   */
  custom?: boolean
}

/** 工具输入参数 */
export interface AskQuestionParams {
  /** 问题列表（支持多问题向导，逐题问） */
  questions: AskQuestionItem[]
}

/** 单个问题的答案 */
export interface AskQuestionAnswer {
  /** 用户选中的选项 label 列表（多选时多个，单选时一个） */
  selectedLabels: string[]
  /** 用户在自定义输入框填写的文本（仅 custom=true 且用户填写了自定义内容时存在） */
  customInput?: string
  /** 用户是否点击了 Dismiss/Cancel（绕过所有问题） */
  dismissed?: boolean
}

/** 工具返回的整体结果 */
export interface AskQuestionResult {
  /** 每个问题的答案（与 questions 顺序对应） */
  answers: AskQuestionAnswer[]
}

/** renderer 端接收到的 IPC 事件 payload */
export interface AskQuestionRequest {
  requestId: string
  questions: AskQuestionItem[]
}