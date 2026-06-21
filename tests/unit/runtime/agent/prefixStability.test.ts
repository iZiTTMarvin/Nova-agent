import { describe, it, expect } from 'vitest'
import { getStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { getModeInstruction } from '../../../../src/runtime/agent/promptBuilder/modeInstruction'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import type { Mode } from '../../../../src/shared/session/types'
import { extractTextFromContent } from '../../../../src/runtime/model/types'

describe('前缀稳定性 (缓存 Harness C2)', () => {
  it('getStableSystemPrompt 对不同模式返回相同内容', () => {
    const prompt = getStableSystemPrompt()
    expect(prompt).toBeTruthy()
    expect(prompt.length).toBeGreaterThan(100)

    // 多次调用返回完全相同的内容（逐字节稳定）
    const prompt2 = getStableSystemPrompt()
    expect(prompt2).toBe(prompt)
  })

  it('getStableSystemPrompt 不包含任何模式特定文本', () => {
    const prompt = getStableSystemPrompt()
    // 不应包含"当前处于 xxx 模式"这种模式特定文本
    expect(prompt).not.toContain('当前处于 plan 模式')
    expect(prompt).not.toContain('当前处于 default 模式')
    expect(prompt).not.toContain('当前处于 auto 模式')
  })

  it('getModeInstruction 为每种模式返回非空文本', () => {
    const modes: Mode[] = ['plan', 'default', 'auto']
    for (const mode of modes) {
      const instruction = getModeInstruction(mode)
      expect(instruction).toBeTruthy()
      expect(instruction.length).toBeGreaterThan(10)
    }
  })

  it('getModeInstruction 包含模式名称标记', () => {
    expect(getModeInstruction('plan')).toContain('plan')
    expect(getModeInstruction('default')).toContain('default')
    expect(getModeInstruction('auto')).toContain('auto')
  })

  it('不同模式的 mode instruction 互不相同', () => {
    const planInstruction = getModeInstruction('plan')
    const defaultInstruction = getModeInstruction('default')
    const autoInstruction = getModeInstruction('auto')

    expect(planInstruction).not.toBe(defaultInstruction)
    expect(defaultInstruction).not.toBe(autoInstruction)
    expect(planInstruction).not.toBe(autoInstruction)
  })

  it('AgentLoop frozenSystemPrompt 包含 Base Rules 层', () => {
    const baseRules = renderBaseRules()
    expect(baseRules).toBeTruthy()

    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      systemPromptLayers: {
        agentRole: buildStableSystemPrompt({ workingDir: '/tmp' }),
        baseRules,
        projectRules: '',
        skillContext: '',
        toolSummary: ''
      }
    })

    const context = loop.getContext()
    const systemMsg = context.find(m => m.role === 'system')
    expect(systemMsg).toBeTruthy()
    const frozen = extractTextFromContent(systemMsg!.content)
    expect(frozen).toContain('=== Base Rules ===')
    expect(frozen).toContain('工具优先级')
    // 模式指令不进 system
    expect(frozen).not.toContain('[当前模式: plan')
  })

  it('modeInstruction 出现在 user 消息末尾而非 system', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const loop = new AgentLoop(client, new EventBus(), {
      systemPromptLayers: {
        agentRole: buildStableSystemPrompt({ workingDir: '/tmp' }),
        baseRules: renderBaseRules(),
        projectRules: '',
        skillContext: '',
        toolSummary: ''
      }
    })
    loop.setMode('plan')

    await loop.sendMessage('分析项目结构')

    const lastChat = client.getCalls().at(-1)
    const userMsg = lastChat?.messages?.find(m => m.role === 'user')
    expect(userMsg).toBeTruthy()
    const userText = extractTextFromContent(userMsg!.content)
    expect(userText).toContain(getModeInstruction('plan'))

    const systemMsg = lastChat?.messages?.find(m => m.role === 'system')
    const systemText = extractTextFromContent(systemMsg?.content ?? '')
    expect(systemText).not.toContain('[当前模式: plan')
  })
})
