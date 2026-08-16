/**
 * 真实 API 缓存门禁 — 压缩命中场景。
 *
 * 前缀对齐收益的自动化证据：用小上下文窗口（约 8K）让压缩在几轮工具对话内触发，
 * 按用途标记识别摘要调用，断言摘要调用本身命中前缀缓存（cacheRead > 0），
 * 且压缩后继续对话的主请求仍命中。token 成本由小窗口与短 fixture 控制。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/runtime/model/types'
import {
  createGateWorkspace,
  formatRequestsTable,
  resolveLiveProvider,
  runLiveConversation,
  type LiveProviderId
} from './gate'

const PROVIDER_IDS: LiveProviderId[] = ['deepseek', 'glm', 'kimi', 'minimax']

/** 压缩窗口：80% 阈值 ≈ 6.5K 估算 token，数轮读取内即可触发 */
const COMPACTION_CONTEXT_WINDOW = 8_192

/**
 * 压缩场景 fixture：6 个中等文件（各约 3.5KB）+ 8 对稳定历史消息。
 * 估算 token：读取约 5.3K + 历史与对话开销 > 6.5K 阈值；消息数 > 22 条切分门槛。
 */
function createCompactionWorkspace(): string {
  const files: Record<string, string> = {}
  const topics = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  for (const topic of topics) {
    files[`notes/${topic}.txt`] = Array.from(
      { length: 48 },
      line => `${topic} 第 ${line + 1} 行：缓存命中要求请求前缀逐字节一致，本行用于稳定撑起上下文体积。`
    ).join('\n') + '\n'
  }
  return createGateWorkspace(files)
}

function createInjectedHistory(): ChatMessage[] {
  return Array.from({ length: 8 }, (_, index): ChatMessage => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `历史对话 ${index + 1}：此前我们确认过 notes 目录下的文件清单与各自的议题范围，这些结论在后续轮次中仍然成立。`
  }))
}

describe.each(PROVIDER_IDS)('真实 API 缓存门禁（压缩）：%s', providerId => {
  const provider = resolveLiveProvider(providerId)

  describe.skipIf(!provider)('压缩摘要命中', () => {
    it(
      '小窗口下压缩触发：摘要调用与压缩后主请求 cacheRead > 0',
      async () => {
        const workspace = createCompactionWorkspace()
        const { client, toolCallCount } = await runLiveConversation({
          provider: provider!,
          workspaceDir: workspace,
          contextWindow: COMPACTION_CONTEXT_WINDOW,
          injectedHistory: createInjectedHistory(),
          maxToolRounds: 10,
          turns: [
            '请依次用 read 工具读取 notes 目录下的全部 6 个 txt 文件（alpha、beta、gamma、delta、epsilon、zeta），然后用三句话总结它们共同的主题。',
            '这些文件都强调同一条要求，那条要求是什么？直接回答。'
          ]
        })

        const all = client.getRequests()

        // 前置：模型确实执行了工具读取，压缩触发条件才可能满足
        expect(
          toolCallCount,
          `模型未按预期执行工具调用（tool_call 事件 ${toolCallCount} 次）`
        ).toBeGreaterThanOrEqual(2)

        // 按用途标记识别摘要调用；未触发说明场景失效，门禁红
        const summaryRequests = all.filter(r => r.purpose === 'compaction-summary')
        expect(
          summaryRequests.length,
          `压缩未在对话内触发（未观察到 compaction-summary 请求）。` +
          `全部请求：\n${formatRequestsTable(all)}`
        ).toBeGreaterThan(0)

        const failures: string[] = []
        for (const request of summaryRequests) {
          if (!request.usage) {
            failures.push(`摘要请求 #${request.index}：provider 未返回 usage，无法判定缓存命中`)
          } else if (request.usage.cacheReadTokens <= 0) {
            failures.push(
              `摘要请求 #${request.index}：cacheRead=${request.usage.cacheReadTokens}（应为 > 0），` +
              `promptTokens=${request.usage.promptTokens} —— 摘要未回放主请求前缀`
            )
          }
        }

        // 压缩后续聊的主请求仍命中（共享冻结 system 前缀）
        const lastSummaryIndex = Math.max(...summaryRequests.map(r => r.index))
        const postCompactionMain = all.filter(
          r => r.purpose === 'main' && r.index > lastSummaryIndex
        )
        expect(
          postCompactionMain.length,
          `压缩后没有继续发出主请求。全部请求：\n${formatRequestsTable(all)}`
        ).toBeGreaterThan(0)
        for (const request of postCompactionMain) {
          if (!request.usage) {
            failures.push(`压缩后主请求 #${request.index}：provider 未返回 usage`)
          } else if (request.usage.cacheReadTokens <= 0) {
            failures.push(
              `压缩后主请求 #${request.index}：cacheRead=${request.usage.cacheReadTokens}（应为 > 0）`
            )
          }
        }

        expect(
          failures,
          `压缩命中断言失败（${provider!.id} / ${provider!.modelId}）：\n` +
          failures.join('\n') +
          '\n全部请求 usage：\n' + formatRequestsTable(all)
        ).toEqual([])
      },
      300_000
    )
  })
})
