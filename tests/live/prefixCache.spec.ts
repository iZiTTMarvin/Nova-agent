/**
 * 真实 API 缓存门禁 — 主请求前缀命中。
 *
 * 显式运行、key 门控、会花钱：默认测试套件与 CI 必跑项不包含本目录。
 * 断言首轮之后的每个主请求都命中服务端前缀缓存（cacheRead > 0）；
 * 谁破坏了主对话的前缀稳定性（比如往 system 头部塞动态内容），这里就会红。
 */
import { describe, expect, it } from 'vitest'
import {
  createGateWorkspace,
  formatRequestsTable,
  resolveLiveProvider,
  runLiveConversation,
  type LiveProviderId
} from './gate'

const PROVIDER_IDS: LiveProviderId[] = ['deepseek', 'glm', 'kimi', 'minimax']

/** 小 fixture：三个短文件，多步工具 turn 的读取对象 */
function createSmallWorkspace(): string {
  return createGateWorkspace({
    'notes/alpha.txt': [
      'alpha 议题：前缀缓存的工作方式。',
      '第 2 行：服务端按请求公共前缀复用已计算的 KV。',
      '第 3 行：命中部分按缓存读取计价。',
      '第 4 行：尾部新增内容照常全价。',
      ''
    ].join('\n'),
    'notes/beta.txt': [
      'beta 议题：会话路由 key 的作用。',
      '第 2 行：会话亲和的 provider 按路由 key 分桶缓存。',
      '第 3 行：同一会话保持同槽位才能命中。',
      '第 4 行：摘要调用也必须携带同一 key。',
      ''
    ].join('\n'),
    'notes/gamma.txt': [
      'gamma 议题：reasoning 回放的一致性。',
      '第 2 行：历史思考链需要按档案策略回放。',
      '第 3 行：回放序列化必须与主请求一致。',
      '第 4 行：剥离会破坏前缀。',
      ''
    ].join('\n')
  })
}

describe.each(PROVIDER_IDS)('真实 API 缓存门禁：%s', providerId => {
  const provider = resolveLiveProvider(providerId)

  describe.skipIf(!provider)('主请求前缀命中', () => {
    it(
      '多步工具 turn + 追问一轮：首轮之后每个主请求 cacheRead > 0',
      async () => {
        const workspace = createSmallWorkspace()
        const { client, toolCallCount } = await runLiveConversation({
          provider: provider!,
          workspaceDir: workspace,
          contextWindow: 128_000,
          turns: [
            '请依次用 read 工具读取 notes/alpha.txt、notes/beta.txt、notes/gamma.txt 这三个文件，然后用一句话概括每个文件的议题。',
            'beta.txt 的第 3 行写了什么？直接回答。'
          ]
        })

        const all = client.getRequests()
        const mainRequests = all.filter(r => r.purpose === 'main')

        // 前置：模型确实执行了多步工具对话，门禁结论才有意义
        expect(
          toolCallCount,
          `模型未按预期执行工具调用（tool_call 事件 ${toolCallCount} 次），门禁无法验证多轮前缀`
        ).toBeGreaterThanOrEqual(2)
        expect(
          mainRequests.length,
          `主请求数不足（${mainRequests.length}），期望多步工具 turn + 追问至少产生 3 次主请求`
        ).toBeGreaterThanOrEqual(3)

        // 断言：首轮之后每次主请求 cacheRead > 0；失败输出定位到具体请求与指标
        const failures: string[] = []
        for (const request of mainRequests.slice(1)) {
          if (!request.usage) {
            failures.push(`请求 #${request.index}：provider 未返回 usage，无法判定缓存命中`)
          } else if (request.usage.cacheReadTokens <= 0) {
            failures.push(
              `请求 #${request.index}：cacheRead=${request.usage.cacheReadTokens}（应为 > 0），` +
              `promptTokens=${request.usage.promptTokens}`
            )
          }
        }
        expect(
          failures,
          `前缀缓存命中断言失败（${provider!.id} / ${provider!.modelId}）：\n` +
          failures.join('\n') +
          '\n全部请求 usage：\n' + formatRequestsTable(all)
        ).toEqual([])
      },
      300_000
    )
  })
})
