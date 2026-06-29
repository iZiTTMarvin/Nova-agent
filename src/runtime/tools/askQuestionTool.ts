/**
 * askQuestionTool —— 向用户提问工具
 *
 * 核心设计：
 * - 阻塞模式：execute() 通过 context.askQuestion 拿到 Promise 并 await
 * - 前后端解耦：工具不直接接触 pendingAskQuestions 或 IPC，只调 context.askQuestion
 * - 无超时自动选：用户必须显式回答或 dismiss，不做自动兜底
 */
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import type { AskQuestionItem, AskQuestionAnswer } from '../../shared/askQuestion/types'
import { ASK_QUESTION_DESCRIPTION } from './askQuestionDescription'

/** 默认开启 custom 输入（参照 kilocode） */
const DEFAULT_CUSTOM = true

export const askQuestionTool: ToolExecutor = {
  name: 'askQuestion',
  description: ASK_QUESTION_DESCRIPTION,
  executionMode: 'sequential',
  isConcurrencySafe: () => false,

  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '问题列表，支持多问题向导（逐题问）',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '问题正文'
            },
            header: {
              type: 'string',
              description: '问题上方的小标题/上下文（可选）'
            },
            options: {
              type: 'array',
              description: '选项列表（至少 1 个）',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项显示文本' },
                  description: { type: 'string', description: '选项说明（可选）' },
                  recommended: {
                    type: 'boolean',
                    description: '是否为推荐项；UI 渲染 "(Recommended)" 标记（可选）'
                  }
                },
                required: ['label']
              }
            },
            multiple: {
              type: 'boolean',
              description: '是否允许多选；false/不填 = 单选'
            },
            custom: {
              type: 'boolean',
              description: '是否允许用户自定义输入；true 时 UI 显示 "Type your own answer" 输入框（默认 true）'
            }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  },

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // 没有 askQuestion 回调（非 agentHandler 上下文）→ 降级 no-op，避免卡死
    if (!context.askQuestion) {
      return {
        success: true,
        output: 'askQuestion skipped: no askQuestion context.'
      }
    }

    const rawQuestions = args.questions
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        success: false,
        output: '',
        error: 'questions 必须是非空数组'
      }
    }

    // 类型守卫：过滤脏数据（缺 question / options 非数组 / 选项缺 label）
    const questions: AskQuestionItem[] = rawQuestions
      .filter((q): q is AskQuestionItem =>
        q != null &&
        typeof q === 'object' &&
        typeof (q as { question?: unknown }).question === 'string' &&
        Array.isArray((q as { options?: unknown }).options) &&
        ((q as { options: unknown[] }).options.length > 0) &&
        (q as { options: unknown[] }).options.every((o) =>
          o != null && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string'
        )
      )
      .map((q) => ({
        ...q,
        // custom 字段默认开启；显式传 false 时保留 false
        custom: q.custom !== undefined ? !!q.custom : DEFAULT_CUSTOM
      }))

    if (questions.length === 0) {
      return {
        success: false,
        output: '',
        error: 'questions 中没有有效的问题（每个问题至少需要 question 和 1 个 options）'
      }
    }

    const requestId = `aq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // 通过 context.askQuestion 拿到 Promise，await 阻塞等待 renderer 回复
    // agentHandler 内部负责：创建 Promise → 存 resolve 到 pendingAskQuestions → emit 事件 → IPC resolve
    const answers = await context.askQuestion(requestId, questions)

    return {
      success: true,
      output: formatAnswers(questions, answers)
    }
  }
}

/**
 * 格式化答案为工具输出字符串。
 * 参照 kilocode 格式：User has answered your questions: "问题文本"="答案".
 *
 * 三种形态：
 * - 全部 dismissed 或 answers 为空 → "User dismissed the question."
 * - 单题 dismissed → 该题输出 `"问题"=[dismissed]`
 * - 正常题 → `"问题"="A, B"`，有 customInput → 追加 `, custom="用户输入"`
 * 整体前缀 "User has answered your questions: "，以 "." 结尾。
 */
function formatAnswers(questions: AskQuestionItem[], answers: AskQuestionAnswer[]): string {
  // 全部 dismissed 或 answers 为空 → 用户跳过了
  if (answers.length === 0 || answers.every(a => a.dismissed)) {
    return 'User dismissed the question.'
  }

  const parts: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const a = answers[i]
    if (!a || a.dismissed) {
      parts.push(`"${q.question}"=[dismissed]`)
      continue
    }
    const selected = a.selectedLabels.join(', ')
    // customInput 仅在用户填写了自定义内容时追加，避免输出多余的空 custom 段
    const customPart = a.customInput ? `, custom="${a.customInput}"` : ''
    parts.push(`"${q.question}"="${selected}"${customPart}`)
  }

  return `User has answered your questions: ${parts.join('; ')}.`
}