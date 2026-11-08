import { describe, it, expect } from 'vitest'
import { getModeInstruction } from '../../../../src/runtime/agent/promptBuilder/modeInstruction'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { renderBaseRules, renderMinimalEngineeringPolicy } from '../../../../src/runtime/agent/promptRenderer'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'

describe('前缀稳定性 (缓存 Harness C2)', () => {
  it('Task Policy 层进入 frozen system prompt 一次且逐字节稳定，不进 user 尾部', async () => {
    const layers = {
      agentRole: buildStableSystemPrompt({ workingDir: '/tmp' }),
      baseRules: renderBaseRules(),
      projectRules: '',
      skillContext: '',
      taskPolicy: renderMinimalEngineeringPolicy(),
      toolSummary: ''
    }

    const frozenOf = (loop: AgentLoop) =>
      extractTextFromContent(loop.getContext().find(m => m.role === 'system')!.content)
    const loop1 = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPromptLayers: layers
    })
    const loop2 = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPromptLayers: layers
    })
    const frozen1 = frozenOf(loop1)
    expect(frozen1.match(/=== Task Policy ===/g)).toHaveLength(1)
    // 同输入两次构建逐字节一致（缓存前缀契约）
    expect(frozenOf(loop2)).toBe(frozen1)

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const loop = new AgentLoop(client, new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPromptLayers: layers
    })
    loop.setMode('plan')
    await loop.sendMessage('重构这个模块', agentRoute())

    const lastChat = client.getCalls().at(-1)
    const userText = extractTextFromContent(
      lastChat?.messages?.find(m => m.role === 'user')?.content ?? ''
    )
    // 模式指令在 user 尾部，Task Policy 只在 system，不随轮次重复注入
    expect(userText).toContain(getModeInstruction('plan'))
    expect(userText).not.toContain('Minimal Engineering Policy')
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
      permissionManager: new PermissionManager(),
      systemPromptLayers: {
        agentRole: buildStableSystemPrompt({ workingDir: '/tmp' }),
        baseRules: renderBaseRules(),
        projectRules: '',
        skillContext: '',
        toolSummary: ''
      }
    })
    loop.setMode('plan')

    await loop.sendMessage('分析项目结构', agentRoute())

    const lastChat = client.getCalls().at(-1)
    const userMsg = lastChat?.messages?.find(m => m.role === 'user')
    expect(userMsg).toBeTruthy()
    const userText = extractTextFromContent(userMsg!.content)
    expect(userText).toContain(getModeInstruction('plan'))

    const systemMsg = lastChat?.messages?.find(m => m.role === 'system')
    const systemText = extractTextFromContent(systemMsg?.content ?? '')
    expect(systemText).not.toContain(getModeInstruction('plan'))
  })

  it('非开发模式且未注入 provider 时本轮失败，模型未收到请求', async () => {
    const client = new MockModelClient()
    const loop = new AgentLoop(client, new EventBus(), {
      permissionManager: new PermissionManager()
    })
    loop.setMode('learn')

    const outcome = await loop.sendMessage('讲讲这个项目', agentRoute())

    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toContain('需要宿主注入每轮指令')
    }
    expect(client.getCalls()).toHaveLength(0)
  })
})
