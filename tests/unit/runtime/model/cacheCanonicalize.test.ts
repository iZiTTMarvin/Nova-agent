/**
 * canonicalizeForCacheComparison 单测
 *
 * 验证前缀缓存视角的请求体规范化：
 * - Anthropic 档案剥离滚动 cache_control marker（假 diff 规避）
 * - 非 Anthropic 档案语义不变
 * - 不修改入参
 */
import { describe, it, expect } from 'vitest'
import { canonicalizeForCacheComparison } from '../../../../src/runtime/model/cacheCanonicalize'

/** 构造 Anthropic 风格的请求体：system + 2 条消息带 cache_control + tools 末尾带 cache_control */
function buildAnthropicBody(opts?: { extraMessage?: boolean }): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: [{ type: 'text', text: '你是编程助手', cache_control: { type: 'ephemeral' } }]
    },
    { role: 'user', content: '第一轮问题' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '第一轮回答', cache_control: { type: 'ephemeral' } }]
    },
    { role: 'user', content: '第二轮问题' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '第二轮回答', cache_control: { type: 'ephemeral' } }]
    }
  ]
  if (opts?.extraMessage) {
    messages.push({ role: 'user', content: '第三轮问题' })
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: '第三轮回答', cache_control: { type: 'ephemeral' } }]
    })
  }
  return {
    model: 'claude-sonnet-4-20250514',
    messages,
    tools: [
      { type: 'function', function: { name: 'read', description: '读取文件', parameters: {} } },
      {
        type: 'function',
        function: { name: 'bash', description: '执行命令', parameters: {} },
        cache_control: { type: 'ephemeral' }
      }
    ]
  }
}

describe('canonicalizeForCacheComparison', () => {
  it('Anthropic 档案：marker 滚动前后规范化结果相同', () => {
    // Turn N：最后 2 条非 system 消息带 marker
    const turnN = buildAnthropicBody()
    // Turn N+1：追加新消息后，marker 滚到新的最后 2 条
    const turnN1 = buildAnthropicBody({ extraMessage: true })

    const canonN = canonicalizeForCacheComparison(turnN, 'anthropic')
    const canonN1 = canonicalizeForCacheComparison(turnN1, 'anthropic')

    // Turn N 的 messages 是 Turn N+1 的前缀（规范化后）
    const msgsN = canonN.messages as unknown[]
    const msgsN1 = canonN1.messages as unknown[]
    expect(JSON.stringify(msgsN1.slice(0, msgsN.length))).toBe(JSON.stringify(msgsN))

    // tools 段规范化后一致（cache_control 被剥离）
    expect(JSON.stringify(canonN.tools)).toBe(JSON.stringify(canonN1.tools))
  })

  it('Anthropic 档案：所有 cache_control 被剥离', () => {
    const body = buildAnthropicBody()
    const canon = canonicalizeForCacheComparison(body, 'anthropic')

    const serialized = JSON.stringify(canon)
    expect(serialized).not.toContain('cache_control')
  })

  it('Anthropic 档案：非 marker 字段变化时结果不同', () => {
    const bodyA = buildAnthropicBody()
    const bodyB = buildAnthropicBody()
    // 修改一条消息的实际内容
    const msgsB = bodyB.messages as Array<Record<string, unknown>>
    msgsB[1] = { role: 'user', content: '完全不同的问题' }

    const canonA = canonicalizeForCacheComparison(bodyA, 'anthropic')
    const canonB = canonicalizeForCacheComparison(bodyB, 'anthropic')

    expect(JSON.stringify(canonA)).not.toBe(JSON.stringify(canonB))
  })

  it('非 Anthropic 档案：语义不变（reasoning_content / tool_calls / tools 顺序保留）', () => {
    const body: Record<string, unknown> = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '问题' },
        {
          role: 'assistant',
          content: '回答',
          reasoning_content: '思考过程',
          tool_calls: [{ id: 'tc_1', function: { name: 'read', arguments: '{"path":"/a.ts"}' } }]
        },
        { role: 'tool', content: '文件内容', tool_call_id: 'tc_1' }
      ],
      tools: [
        { type: 'function', function: { name: 'read', description: '读取', parameters: {} } },
        { type: 'function', function: { name: 'bash', description: '命令', parameters: {} } }
      ]
    }

    const canon = canonicalizeForCacheComparison(body, 'deepseek')

    // 深拷贝后语义完全一致
    expect(canon).toEqual(JSON.parse(JSON.stringify(body)))
  })

  it('不修改入参', () => {
    const body = buildAnthropicBody()
    const before = JSON.stringify(body)

    canonicalizeForCacheComparison(body, 'anthropic')

    expect(JSON.stringify(body)).toBe(before)
  })

  it('接受 CacheProfile 对象作为入参', () => {
    const body = buildAnthropicBody()
    const canonById = canonicalizeForCacheComparison(body, 'anthropic')
    const canonByProfile = canonicalizeForCacheComparison(body, {
      id: 'anthropic',
      marker: 'cache_control',
      promptCacheKey: 'never',
      reasoningReplay: 'none',
      idlePolicy: 'anthropic-short-ttl'
    })

    expect(JSON.stringify(canonById)).toBe(JSON.stringify(canonByProfile))
  })

  it('字符串 content 的 cache_control 也被剥离', () => {
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: '系统提示', cache_control: { type: 'ephemeral' } },
        { role: 'user', content: '问题' }
      ]
    }

    const canon = canonicalizeForCacheComparison(body, 'anthropic')
    const msgs = canon.messages as Array<Record<string, unknown>>
    expect(msgs[0]).not.toHaveProperty('cache_control')
    expect(msgs[0].content).toBe('系统提示')
  })
})
