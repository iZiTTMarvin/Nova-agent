/**
 * MemoryExtractor 单测：候选 JSON 边界校验、隐私二次过滤、证据溯源（自我污染防护）、
 * 输入投影与 fail-soft。chat 依赖全部用 fake。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  MemoryExtractor,
  parseMemoryCandidateResponse,
  projectExtractionMessages,
  buildEvidenceProvenance
} from '../../../../src/runtime/memory/extraction/MemoryExtractor'
import type { ChatMessage } from '../../../../src/runtime/model/types'

const USER_TEXT = '以后我的 commit message 都按 feat:/fix: 这种风格来写'
const TOOL_TEXT = 'package.json 的 scripts 里使用 vitest 运行单元测试'
const ASSISTANT_TEXT = '好的，已记录你的偏好：你经常用 React 和 TypeScript'

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: USER_TEXT },
  { role: 'assistant', content: ASSISTANT_TEXT },
  { role: 'tool', content: TOOL_TEXT }
]

const PROVENANCE = buildEvidenceProvenance(MESSAGES, [])

function candidateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      kind: 'convention',
      scopeHint: 'project',
      key: 'commit.style',
      content: 'commit message 使用 feat:/fix: 前缀',
      explicitness: 'user_explicit',
      confidence: 0.9,
      intent: 'assert',
      evidence: [{ type: 'user_message', excerpt: USER_TEXT }],
      ...overrides
    }
  ])
}

describe('projectExtractionMessages（自我污染防护·输入投影层）', () => {
  it('只有记忆查询时不发起无有效证据的提炼', async () => {
    const chat = vi.fn()
    const extractor = new MemoryExtractor({ chat })
    await extractor.extract({ sessionId: 's', observations: [], recentMessages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'm', name: 'memory_search', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'm', content: '旧记忆' }
    ] })
    expect(chat).not.toHaveBeenCalled()
  })
  it('主动读取的旧记忆不能作为新的工具证据', () => {
    const input: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'memory-1', name: 'memory_search', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'memory-1', content: '此前决定用旧架构' },
      { role: 'tool', toolCallId: 'read-1', content: '当前源码使用新架构' }
    ]
    const projected = projectExtractionMessages(input)
    expect(projected.some(message => message.toolCallId === 'memory-1')).toBe(false)
    expect(buildEvidenceProvenance(projected, []).toolTexts).toEqual(['当前源码使用新架构'])
  })
  it('剔除 internal / skipCacheMarker / system 消息，保留真实会话消息', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...MESSAGES,
      { role: 'user', content: '=== Relevant Memory ===\n- [preference] 用户经常使用 React', skipCacheMarker: true },
      { role: 'user', content: '压缩指令', internal: true }
    ]
    const projected = projectExtractionMessages(input)
    expect(projected.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(projected.some((m) => m.content.includes('Relevant Memory'))).toBe(false)
  })
})

describe('parseMemoryCandidateResponse', () => {
  it('合法 JSON 解析为候选：key 归一化、置信度 clamp、intent 缺省 assert', () => {
    const result = parseMemoryCandidateResponse(
      candidateJson({ key: '  Commit.Style ', confidence: 1.5, intent: undefined }),
      PROVENANCE
    )
    expect(result?.candidates).toHaveLength(1)
    expect(result?.candidates[0]).toMatchObject({
      kind: 'convention',
      memoryKey: 'commit.style',
      confidence: 1,
      intent: 'assert',
      evidence: [{ type: 'user_message', excerpt: USER_TEXT }]
    })
  })

  it('单条非法只丢弃该条，不影响其余（枚举外 kind / intent、非数值 confidence）', () => {
    const result = parseMemoryCandidateResponse(
      JSON.stringify([
        { kind: 'wrong_kind', scopeHint: 'project', content: 'x', explicitness: 'observed', confidence: 0.5, evidence: [{ type: 'user_message', excerpt: USER_TEXT }] },
        JSON.parse(candidateJson())[0],
        { kind: 'convention', scopeHint: 'project', content: 'x', explicitness: 'observed', confidence: 0.5, intent: 'wrong', evidence: [{ type: 'user_message', excerpt: USER_TEXT }] },
        { kind: 'convention', scopeHint: 'project', content: 'x', explicitness: 'observed', confidence: 'high', evidence: [{ type: 'user_message', excerpt: USER_TEXT }] }
      ]),
      PROVENANCE
    )
    expect(result?.candidates).toHaveLength(1)
    expect(result?.droppedCount).toBe(3)
  })

  it('evidence 枚举外的 type 条目被丢弃；证据全灭则整条丢弃', () => {
    const singleBad = parseMemoryCandidateResponse(
      candidateJson({ evidence: [{ type: 'assistant_message', excerpt: USER_TEXT }] }),
      PROVENANCE
    )
    expect(singleBad?.candidates).toHaveLength(0)
    expect(singleBad?.droppedCount).toBe(1)
  })

  it('敏感 excerpt 被 PrivacyFilter 拦截（原文在输入中也不得成为证据）', () => {
    const SENSITIVE_TEXT = '我的 api_key=sk-abcdefghijklmnop1234 请保管'
    const sensitiveProvenance = buildEvidenceProvenance(
      [{ role: 'user', content: SENSITIVE_TEXT }],
      []
    )
    const result = parseMemoryCandidateResponse(
      candidateJson({ evidence: [{ type: 'user_message', excerpt: SENSITIVE_TEXT }] }),
      sensitiveProvenance
    )
    expect(result?.candidates).toHaveLength(0)
  })

  it('excerpt 未逐字命中同角色原文即丢弃（助手复述无法冒充用户证据）', () => {
    const assistantQuote = parseMemoryCandidateResponse(
      candidateJson({ evidence: [{ type: 'user_message', excerpt: '你经常用 React 和 TypeScript' }] }),
      PROVENANCE
    )
    expect(assistantQuote?.candidates).toHaveLength(0)

    const toolEvidence = parseMemoryCandidateResponse(
      candidateJson({
        evidence: [{ type: 'tool_result', excerpt: 'scripts 里使用 vitest 运行单元测试' }]
      }),
      PROVENANCE
    )
    expect(toolEvidence?.candidates).toHaveLength(1)
  })

  it('excerpt 先过隐私过滤再截断到硬上限', () => {
    const longUserText = `${'构建 '.repeat(200)}完成`
    const provenance = buildEvidenceProvenance(
      [{ role: 'user', content: longUserText }],
      []
    )
    const result = parseMemoryCandidateResponse(
      candidateJson({ evidence: [{ type: 'user_message', excerpt: longUserText }] }),
      provenance
    )
    const excerpt = result?.candidates[0]?.evidence[0]?.excerpt
    expect(excerpt).toBeDefined()
    expect(excerpt!.length).toBeLessThanOrEqual(240)
  })

  it('content 过隐私过滤后保留 [REDACTED]，不再含原文密钥', () => {
    const provenance = buildEvidenceProvenance(
      [{ role: 'user', content: `${USER_TEXT} 我的 api_key=sk-abcdefghijklmnop1234` }],
      []
    )
    const result = parseMemoryCandidateResponse(
      candidateJson({ content: '用户的 api_key=sk-abcdefghijklmnop1234 属于敏感信息需要轮换' }),
      provenance
    )
    expect(result?.candidates).toHaveLength(1)
    expect(result?.candidates[0]?.content).toContain('[REDACTED]')
    expect(result?.candidates[0]?.content).not.toContain('sk-abcdefghijklmnop1234')
  })

  it('空数组、非 JSON、非数组：分别返回空候选 / null / null', () => {
    expect(parseMemoryCandidateResponse('[]', PROVENANCE)).toEqual({ candidates: [], droppedCount: 0 })
    expect(parseMemoryCandidateResponse('not json', PROVENANCE)).toBeNull()
    expect(parseMemoryCandidateResponse('{"kind":"convention"}', PROVENANCE)).toBeNull()
  })

  it('markdown 代码块包裹的 JSON 可解析', () => {
    const result = parseMemoryCandidateResponse(`\`\`\`json\n${candidateJson()}\n\`\`\``, PROVENANCE)
    expect(result?.candidates).toHaveLength(1)
  })
})

describe('MemoryExtractor.extract（fail-soft）', () => {
  const INPUT = {
    sessionId: 'sess-1',
    recentMessages: MESSAGES,
    observations: []
  }

  it('正常返回候选数组', async () => {
    const extractor = new MemoryExtractor({ chat: vi.fn().mockResolvedValue(candidateJson()) })
    const candidates = await extractor.extract(INPUT)
    expect(candidates).toHaveLength(1)
    expect(candidates?.[0].memoryKey).toBe('commit.style')
  })

  it('网络异常返回 null；输入投影后为空返回 null 且不调用模型', async () => {
    const chat = vi.fn()
    const extractor = new MemoryExtractor({ chat })
    await expect(
      extractor.extract({
        sessionId: 'sess-1',
        recentMessages: [{ role: 'user', content: 'x', skipCacheMarker: true }],
        observations: []
      })
    ).resolves.toBeNull()
    expect(chat).not.toHaveBeenCalled()

    const failing = new MemoryExtractor({ chat: vi.fn().mockRejectedValue(new Error('network')) })
    await expect(failing.extract(INPUT)).resolves.toBeNull()
  })
})
