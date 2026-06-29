/**
 * askQuestionTool 单元测试
 *
 * 覆盖 docs/askQuestion-落地方案.md §9.1 列出的 5 个场景：
 * 1. 正常回答 → output 含 `"问题"="A"`
 * 2. dismiss（`answers: []`）→ output 为 `User dismissed the question.`
 * 3. 无 `context.askQuestion` → 降级 no-op，`success: true`，output 含 `skipped`
 * 4. 空 questions → `success: false`，error 含 `questions`
 * 5. 多问题多选 + customInput → 格式化正确拼接
 *
 * mock 策略：直接构造一个带 askQuestion 的 ToolContext，把 askQuestion 设为
 * vi.fn 返回预设答案。完全不影响全局，也不依赖 vi.spyOn。
 */
import { describe, expect, it, vi } from 'vitest'
import { askQuestionTool } from '../../../../src/runtime/tools/askQuestionTool'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../../src/shared/askQuestion/types'

/** 构造一个最小 ToolContext，仅含 askQuestion 回调（其他字段工具用不到） */
function createContextWithAskQuestion(
  askQuestion: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
): ToolContext {
  return {
    workingDir: process.cwd(),
    readState: { isRead: () => false, markRead: () => {}, clear: () => {}, clone: () => ({}) } as any,
    askQuestion
  } as unknown as ToolContext
}

describe('askQuestionTool — 静态属性', () => {
  it('executionMode 为 sequential，isConcurrencySafe() 返回 false', () => {
    expect(askQuestionTool.name).toBe('askQuestion')
    expect(askQuestionTool.executionMode).toBe('sequential')
    expect(askQuestionTool.isConcurrencySafe?.({} as any, {} as any)).toBe(false)
  })

  it('ToolRegistry 注册后 getToolDefinitions() 含 askQuestion', () => {
    // 集成自验证：agentHandler.ts 把 askQuestionTool 注册到 ToolRegistry 后，
    // 模型看到的工具列表里必须能找到 askQuestion，否则模型永远无法发起提问。
    const registry = new ToolRegistry()
    registry.register(askQuestionTool)

    const defs = registry.getToolDefinitions()
    const askDef = defs.find(d => (d as { name?: string }).name === 'askQuestion')
    expect(askDef, 'getToolDefinitions 必须含 askQuestion').toBeDefined()
    expect((askDef!.parameters as { required?: string[] }).required).toContain('questions')
  })
})

describe('askQuestionTool.execute — 场景 1：正常回答', () => {
  it('单题单选：output 含 `"问题"="A"`，整体前缀 + 句末句号', async () => {
    const mockAsk = vi.fn(async () => [{ selectedLabels: ['A'] }])
    const context = createContextWithAskQuestion(mockAsk)

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('"选哪个？"="A"')
    expect(result.output.startsWith('User has answered your questions: ')).toBe(true)
    expect(result.output.endsWith('.')).toBe(true)
    // mock 被调用一次，requestId 形如 aq_<ts>_<random>
    expect(mockAsk).toHaveBeenCalledTimes(1)
    const requestId = mockAsk.mock.calls[0][0]
    expect(requestId).toMatch(/^aq_\d+_[a-z0-9]+$/)
  })
})

describe('askQuestionTool.execute — 场景 2：dismiss', () => {
  it('answers 为空数组 → output 为 User dismissed the question.', async () => {
    const mockAsk = vi.fn(async () => [] as AskQuestionAnswer[])
    const context = createContextWithAskQuestion(mockAsk)

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('User dismissed the question.')
  })

  it('answers 全部 dismissed:true → 同样判为用户跳过', async () => {
    const mockAsk = vi.fn(async () => [{ dismissed: true }])
    const context = createContextWithAskQuestion(mockAsk)

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toBe('User dismissed the question.')
  })
})

describe('askQuestionTool.execute — 场景 3：无 askQuestion 回调 → 降级', () => {
  it('context.askQuestion 为 undefined → success:true，output 含 skipped', async () => {
    const context = {
      workingDir: process.cwd()
    } as ToolContext

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('skipped')
    expect(result.output).toContain('askQuestion skipped')
  })
})

describe('askQuestionTool.execute — 场景 4：非法 questions', () => {
  it('questions 非数组 → success:false，error 含 questions', async () => {
    const context = createContextWithAskQuestion(vi.fn(async () => []))

    const result = await askQuestionTool.execute({ questions: 'not-an-array' as any }, context)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/questions/)
    expect(result.error).toContain('非空数组')
  })

  it('questions 为空数组 → success:false，error 含 questions', async () => {
    const context = createContextWithAskQuestion(vi.fn(async () => []))

    const result = await askQuestionTool.execute({ questions: [] }, context)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/questions/)
  })

  it('questions 全为脏数据（缺 options）→ success:false，error 含 "没有有效的问题"', async () => {
    const context = createContextWithAskQuestion(vi.fn(async () => []))

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1' /* 缺 options */ },
          { /* 缺 question + options */ }
        ] as any
      },
      context
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('没有有效的问题')
  })
})

describe('askQuestionTool.execute — 场景 5：多问题多选 + customInput', () => {
  it('多题单选 + 多选 + customInput：分号分隔、整体句号结尾、custom 拼接', async () => {
    const mockAsk = vi.fn(async () => [
      // Q1 单选
      { selectedLabels: ['主题A'] },
      // Q2 多选
      { selectedLabels: ['降低饱和度', '保持原样'] },
      // Q3 仅 custom
      { selectedLabels: [], customInput: '用户自定义文本' }
    ])
    const context = createContextWithAskQuestion(mockAsk)

    const result = await askQuestionTool.execute(
      {
        questions: [
          {
            question: '你想使用哪种暗色主题？',
            options: [{ label: '主题A' }, { label: '主题B' }]
          },
          {
            question: '暗色模式下图片如何处理？',
            options: [{ label: '降低饱和度' }, { label: '保持原样' }],
            multiple: true
          },
          {
            question: '还有什么偏好？',
            options: [{ label: '占位' }],
            custom: true
          }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    // 多题间用 `; ` 分隔
    expect(result.output).toContain('"你想使用哪种暗色主题？"="主题A"')
    expect(result.output).toContain('"暗色模式下图片如何处理？"="降低饱和度, 保持原样"')
    expect(result.output).toContain('"还有什么偏好？"=""')
    // customInput 仅在用户填写了自定义内容时追加
    expect(result.output).toContain(', custom="用户自定义文本"')
    // 整体句末以 . 结尾
    expect(result.output.endsWith('.')).toBe(true)
  })

  it('单题 dismissed + 其他正常：dismissed 题输出 `[dismissed]`', async () => {
    const mockAsk = vi.fn(async () => [
      { selectedLabels: ['A'] },
      { dismissed: true }
    ])
    const context = createContextWithAskQuestion(mockAsk)

    const result = await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] },
          { question: 'Q2', options: [{ label: 'B' }] }
        ]
      },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('"Q1"="A"')
    expect(result.output).toContain('"Q2"=[dismissed]')
  })
})

describe('askQuestionTool.execute — custom 字段默认值', () => {
  it('custom 缺省 → 经工具处理后默认补 true（透传给 UI / IPC payload）', async () => {
    const mockAsk = vi.fn(async (_id, questions) => {
      expect(questions[0].custom).toBe(true)
      return [{ selectedLabels: ['A'] }]
    })
    const context = createContextWithAskQuestion(mockAsk)

    await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }] /* 不传 custom */ }
        ]
      },
      context
    )

    expect(mockAsk).toHaveBeenCalledTimes(1)
  })

  it('custom 显式 false → 保留 false，不被默认值覆盖', async () => {
    const mockAsk = vi.fn(async (_id, questions) => {
      expect(questions[0].custom).toBe(false)
      return [{ selectedLabels: ['A'] }]
    })
    const context = createContextWithAskQuestion(mockAsk)

    await askQuestionTool.execute(
      {
        questions: [
          { question: 'Q1', options: [{ label: 'A' }], custom: false }
        ]
      },
      context
    )

    expect(mockAsk).toHaveBeenCalledTimes(1)
  })
})