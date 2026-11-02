/**
 * 动态工具激活的最终请求前缀：真实 AgentLoop + ToolAvailability + ToolRegistry。
 * Native 走 mock fetch 捕获 HTTP body；XML 走 MockModelClient 捕获 messages。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { canonicalizeForCacheComparison } from '../../../../src/runtime/model/cacheCanonicalize'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { ToolAvailability } from '../../../../src/runtime/tools/availability/ToolAvailability'
import { createLoadToolsTool, LOAD_TOOLS_CONTRACT_MARKER } from '../../../../src/runtime/tools/loadTools'
import { listGroupToolNames } from '../../../../src/runtime/tools/catalog'
import {
  projectBaselineToolDefinitions,
  projectEffectiveToolDefinitions
} from '../../../../src/runtime/agent/core/AgentContext'
import {
  renderToolInventory,
  renderXmlToolContracts,
  xmlToolDisclosureCovers
} from '../../../../src/runtime/agent/promptBuilder/toolPromptRenderer'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { ToolDefinition } from '../../../../src/runtime/model/types'
import type { ToolExecutor, ToolResult } from '../../../../src/runtime/tools/types'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { LOAD_TOOLS_ACTIVATED_MARKER } from '../../../../src/runtime/tools/availability'

const AGENT_MEMBERS = [...listGroupToolNames('agent')]

function stubTool(name: string, execute?: () => Promise<ToolResult>): ToolExecutor {
  return {
    name,
    description: `${name} stub`,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return execute ? execute() : { success: true, output: `${name}-ok` }
    }
  }
}

function createEconomyHarness(opts?: { taskExecute?: () => Promise<ToolResult>; xml?: boolean }) {
  const availability = new ToolAvailability()
  availability.setEconomyMode('on')
  const registry = new ToolRegistry()
  registry.register(stubTool('ls'))
  registry.register(stubTool('read'))
  for (const name of AGENT_MEMBERS) {
    if (name === 'task' && opts?.taskExecute) {
      registry.register(stubTool(name, opts.taskExecute))
    } else {
      registry.register(stubTool(name))
    }
  }
  const registeredToolNames = registry.getToolDefinitions().map(def => def.name)
  registry.register(
    createLoadToolsTool({
      getAvailability: () => availability,
      registeredToolNames,
      ...(opts?.xml ? {
        renderActivatedContract: memberNames => {
          const wanted = new Set(memberNames)
          return renderXmlToolContracts(
            projectEffectiveToolDefinitions('default', registry.getToolDefinitions(), availability)
              .filter(def => wanted.has(def.name))
          )
        }
      } : {})
    })
  )
  availability.bindRegisteredToolNames(registry.getToolDefinitions().map(def => def.name))
  const baseline = projectBaselineToolDefinitions(
    'default',
    registry.getToolDefinitions(),
    availability
  )
  return { availability, registry, baseline }
}

function firstApiMessage(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('请求体缺少 messages')
  }
  return messages[0] as Record<string, unknown>
}

function systemText(message: Record<string, unknown> | { content?: unknown } | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return JSON.stringify(content ?? '')
}

function toolArray(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
}

function assertToolsPrefix(
  previous: Array<Record<string, unknown>>,
  next: Array<Record<string, unknown>>,
  label: string
): void {
  expect(next.length, label).toBeGreaterThanOrEqual(previous.length)
  expect(
    JSON.stringify(next.slice(0, previous.length)),
    `${label}：旧 tools 必须是新 tools 的逐字节前缀`
  ).toBe(JSON.stringify(previous))
}

function sseToolCall(id: string, name: string, args: Record<string, unknown>): ReadableStream {
  const encoder = new TextEncoder()
  const argumentsJson = JSON.stringify(JSON.stringify(args))
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":${argumentsJson}}}]},"finish_reason":null}]}\n\n`
      ))
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      ))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

function sseStop(text = '完成。'): ReadableStream {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}},"finish_reason":"stop"}]}\n\n`
      ))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

function interceptScriptedFetch(script: Array<'load_tools' | 'stop'>): {
  rawBodies: string[]
  bodies: Array<Record<string, unknown>>
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  const rawBodies: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  globalThis.fetch = async (_url, init) => {
    const raw = String(init?.body ?? '')
    rawBodies.push(raw)
    bodies.push(JSON.parse(raw) as Record<string, unknown>)
    const kind = script[call] ?? 'stop'
    call += 1
    const stream = kind === 'load_tools'
      ? sseToolCall(`tc_load_${call}`, 'load_tools', { group: 'agent' })
      : sseStop()
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }
  return {
    rawBodies,
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch
    }
  }
}

function createNativeLoop(
  availability: ToolAvailability,
  registry: ToolRegistry,
  baseline: ToolDefinition[],
  client: OpenAICompatibleModelClient,
  frozen?: string
): AgentLoop {
  const toolSummary = renderToolInventory(baseline, { dialect: 'native' })
  const loop = new AgentLoop(client, new EventBus(), {
    permissionManager: new PermissionManager(),
    permissionMode: 'full_access',
    contextWindow: 1_000_000,
    toolDialectOverride: 'native',
    ...(frozen ? { reuseFrozenSystemPrompt: frozen } : {}),
    systemPromptLayers: {
      agentRole: '你是缓存前缀测试助手。',
      toolSummary
    },
    toolSummaryRenderer: defs => renderToolInventory(defs, { dialect: 'native' })
  })
  loop.setToolRegistry(registry)
  loop.setToolAvailability(availability)
  loop.setMode('default')
  return loop
}

describe('Native 最终 HTTP：激活后 tools 前缀与 system 稳定', () => {
  const loops: AgentLoop[] = []
  let interceptor: ReturnType<typeof interceptScriptedFetch> | null = null

  afterEach(() => {
    interceptor?.restore()
    interceptor = null
    for (const loop of loops) loop.dispose()
    loops.length = 0
  })

  it('load_tools 激活前后旧 tools 是新 tools 的逐字节前缀；重建 AgentLoop 后仍成立', async () => {
    interceptor = interceptScriptedFetch(['load_tools', 'stop', 'stop', 'stop'])
    const { availability, registry, baseline } = createEconomyHarness()
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-chat'
    })
    const loop = createNativeLoop(availability, registry, baseline, client)
    loops.push(loop)

    await loop.sendMessage('请加载 agent 工具组', agentRoute())
    expect(interceptor.bodies).toHaveLength(2)

    const toolsBefore = toolArray(interceptor.bodies[0])
    const toolsAfter = toolArray(interceptor.bodies[1])
    expect(toolsBefore.map(t => (t.function as { name: string }).name)).toEqual(
      baseline.map(def => def.name)
    )
    const namesAfter = toolsAfter.map(t => (t.function as { name: string }).name)
    expect(namesAfter.slice(0, toolsBefore.length)).toEqual(
      toolsBefore.map(t => (t.function as { name: string }).name)
    )
    expect(namesAfter.slice(toolsBefore.length)).toEqual(AGENT_MEMBERS)
    assertToolsPrefix(toolsBefore, toolsAfter, '同回合激活后')
    expect(systemText(firstApiMessage(interceptor.bodies[0])))
      .toBe(systemText(firstApiMessage(interceptor.bodies[1])))
    expect(systemText(firstApiMessage(interceptor.bodies[0])))
      .not.toContain('<invoke name="task"')
    expect(namesAfter).toContain('task')
    const activationResult = (interceptor.bodies[1].messages as Array<Record<string, unknown>>)
      .find(message => message.role === 'tool')
    expect(systemText(activationResult)).not.toContain(LOAD_TOOLS_CONTRACT_MARKER)
    expect(systemText(activationResult)).not.toContain('<invoke name="task"')

    const prevMsgs = canonicalizeForCacheComparison(interceptor.bodies[0], 'deepseek').messages as unknown[]
    const currMsgs = canonicalizeForCacheComparison(interceptor.bodies[1], 'deepseek').messages as unknown[]
    expect(JSON.stringify(currMsgs.slice(0, prevMsgs.length))).toBe(JSON.stringify(prevMsgs))

    await loop.sendMessage('继续', agentRoute())
    expect(interceptor.bodies).toHaveLength(3)
    assertToolsPrefix(toolsAfter, toolArray(interceptor.bodies[2]), '下一用户回合')
    expect(systemText(firstApiMessage(interceptor.bodies[2])))
      .toBe(systemText(firstApiMessage(interceptor.bodies[0])))

    const persist = availability.getPersistableState()
    expect(persist?.version).toBe(2)
    const frozen = loop.getFrozenSystemPrompt()
    const history = loop.getContext().filter(message => message.role !== 'system')
    const diag = loop.getDiagnosticPersistState()
    loop.dispose()

    const restored = new ToolAvailability()
    restored.setEconomyMode('on')
    restored.bindRegisteredToolNames(registry.getToolDefinitions().map(def => def.name))
    const restoreResult = restored.restoreFromSessionState(persist, history)
    expect(restoreResult.usable).toBe(true)
    expect(restoreResult.orderMigrated).toBe(false)

    const loop2 = createNativeLoop(restored, registry, baseline, client, frozen)
    loops.push(loop2)
    loop2.injectHistory(history)
    loop2.restoreDiagnosticPersistState(diag)
    await loop2.sendMessage('重建后继续', agentRoute())

    expect(interceptor.bodies).toHaveLength(4)
    assertToolsPrefix(toolArray(interceptor.bodies[2]), toolArray(interceptor.bodies[3]), '重建 AgentLoop')
    expect(systemText(firstApiMessage(interceptor.bodies[3]))).toBe(frozen)
    const observation = loop2.getCacheDiagnosticObservation()
    expect(observation.firstDiffPart).not.toBe('tools')
  })

  it('Anthropic：追加工具后基线锚点 cache_control 不变，marker 不超限', async () => {
    interceptor = interceptScriptedFetch(['load_tools', 'stop'])
    const { availability, registry, baseline } = createEconomyHarness()
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelId: 'claude-sonnet',
      cacheStrategy: 'anthropic'
    })
    const loop = createNativeLoop(availability, registry, baseline, client)
    loops.push(loop)
    await loop.sendMessage('请加载 agent 工具组', agentRoute())

    const toolsBefore = toolArray(interceptor.bodies[0])
    const toolsAfter = toolArray(interceptor.bodies[1])
    assertToolsPrefix(toolsBefore, toolsAfter, 'Anthropic raw tools')
    expect(toolsBefore.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(toolsAfter[toolsBefore.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(toolsAfter.at(-1)).not.toHaveProperty('cache_control')
    const markerCount = JSON.stringify(toolsAfter).split('"cache_control"').length - 1
    expect(markerCount).toBe(1)
    expect(JSON.stringify(toolsAfter)).not.toContain('cacheAnchor')
    expect(baseline.some(def => def.cacheAnchor === true)).toBe(true)
  })

  it('economy=off 且工具集不变时请求 tools 与 marker 保持兼容', async () => {
    interceptor = interceptScriptedFetch(['stop', 'stop'])
    const availability = new ToolAvailability()
    availability.setEconomyMode('off')
    const registry = new ToolRegistry()
    registry.register(stubTool('ls'))
    registry.register(stubTool('read'))
    availability.bindRegisteredToolNames(['ls', 'read'])
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      modelId: 'claude-sonnet',
      cacheStrategy: 'anthropic'
    })
    const loop = new AgentLoop(client, new EventBus(), {
      permissionManager: new PermissionManager(),
      permissionMode: 'full_access',
      contextWindow: 1_000_000,
      toolDialectOverride: 'native',
      systemPrompt: 'economy off 兼容'
    })
    loops.push(loop)
    loop.setToolRegistry(registry)
    loop.setToolAvailability(availability)
    await loop.sendMessage('第一轮', agentRoute())
    await loop.sendMessage('第二轮', agentRoute())
    expect(JSON.stringify(toolArray(interceptor.bodies[0]))).toBe(
      JSON.stringify(toolArray(interceptor.bodies[1]))
    )
    expect(toolArray(interceptor.bodies[0]).at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(toolArray(interceptor.bodies[0])[0]).not.toHaveProperty('cache_control')
  })
})

describe('XML 全链路：激活不改写 system，契约进入历史', () => {
  const loops: AgentLoop[] = []

  afterEach(() => {
    for (const loop of loops) loop.dispose()
    loops.length = 0
  })

  function xmlInvoke(name: string, params = ''): string {
    return params
      ? `<invoke name="${name}">${params}</invoke>`
      : `<invoke name="${name}"></invoke>`
  }

  function createXmlLoop(
    client: MockModelClient,
    availability: ToolAvailability,
    registry: ToolRegistry,
    baseline: ToolDefinition[],
    frozen?: string
  ): AgentLoop {
    const toolSummary = renderToolInventory(baseline, { dialect: 'xml' })
    const loop = new AgentLoop(client, new EventBus(), {
      permissionManager: new PermissionManager(),
      permissionMode: 'full_access',
      contextWindow: 1_000_000,
      toolDialectOverride: 'xml',
      ...(frozen ? { reuseFrozenSystemPrompt: frozen } : {}),
      systemPromptLayers: {
        agentRole: '你是 XML 缓存前缀测试助手。',
        toolSummary
      },
      toolSummaryRenderer: defs => renderToolInventory(defs, { dialect: 'xml' })
    })
    loop.setToolRegistry(registry)
    loop.setToolAvailability(availability)
    loop.setMode('default')
    return loop
  }

  it('激活不改写旧 system，完整调用契约进入持久历史，重建后仍可调用', async () => {
    const executed: string[] = []
    const { availability, registry, baseline } = createEconomyHarness({
      xml: true,
      taskExecute: async () => {
        executed.push('task')
        return { success: true, output: 'task-ran' }
      }
    })
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: xmlInvoke('load_tools', '<parameter name="group">agent</parameter>') },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '已激活。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: xmlInvoke('task') },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '任务完成。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: xmlInvoke('task') },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '重建后仍可调用。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const loop = createXmlLoop(client, availability, registry, baseline)
    loops.push(loop)
    await loop.sendMessage('加载 agent 组', agentRoute())

    const calls = client.getCalls()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0].tools).toBeUndefined()
    const system0 = systemText(calls[0].messages[0] as Record<string, unknown>)
    expect(system0).toContain('or a tool later activated by a successful load_tools call')
    expect(system0).not.toContain('<invoke name="task"')
    expect(systemText(calls[1].messages[0] as Record<string, unknown>)).toBe(system0)

    const toolResult = calls[1].messages.find(message => message.role === 'tool')
    const resultText = systemText(toolResult as Record<string, unknown>)
    expect(resultText).toContain(`${LOAD_TOOLS_ACTIVATED_MARKER}agent`)
    expect(resultText).toContain(LOAD_TOOLS_CONTRACT_MARKER)
    expect(resultText).toContain('<invoke name="task"')
    const activatedDefinitions = projectEffectiveToolDefinitions(
      'default',
      registry.getToolDefinitions(),
      availability
    ).filter(def => AGENT_MEMBERS.includes(def.name))
    expect(xmlToolDisclosureCovers(activatedDefinitions, resultText)).toBe(true)

    await loop.sendMessage('调用 task', agentRoute())
    expect(executed).toEqual(['task'])

    const persist = availability.getPersistableState()
    const frozen = loop.getFrozenSystemPrompt()
    const history = loop.getContext().filter(message => message.role !== 'system')
    const historyCorpus = history
      .filter(message => message.role === 'tool')
      .map(message => systemText(message as Record<string, unknown>))
      .join('\n')
    expect(xmlToolDisclosureCovers(activatedDefinitions, historyCorpus)).toBe(true)
    expect(xmlToolDisclosureCovers(activatedDefinitions, frozen)).toBe(false)

    loop.dispose()
    const restored = new ToolAvailability()
    restored.setEconomyMode('on')
    restored.bindRegisteredToolNames(registry.getToolDefinitions().map(def => def.name))
    restored.restoreFromSessionState(persist, history)
    const loop2 = createXmlLoop(client, restored, registry, baseline, frozen)
    loops.push(loop2)
    loop2.injectHistory(history)
    await loop2.sendMessage('再建一次 task', agentRoute())
    expect(executed).toEqual(['task', 'task'])
    const rebuildCalls = client.getCalls()
    expect(systemText(rebuildCalls.at(-2)!.messages[0] as Record<string, unknown>)).toBe(frozen)
  })

  it('历史缺失时披露覆盖失败，必须显式换代而不是能力/披露分裂', () => {
    const { availability, registry, baseline } = createEconomyHarness()
    availability.activate('agent')
    const frozen = renderToolInventory(baseline, { dialect: 'xml' })
    const members = availability.getActivatedGroupOrder().flatMap(group => [...listGroupToolNames(group)])
    const definitions = registry.getToolDefinitions().filter(def => members.includes(def.name))
    expect(xmlToolDisclosureCovers(definitions, frozen)).toBe(false)
    expect(availability.isToolAvailable('task')).toBe(true)
    const rebuiltCatalog = renderToolInventory(
      registry.getToolDefinitions().filter(def =>
        baseline.some(b => b.name === def.name) || members.includes(def.name)
      ),
      { dialect: 'xml' }
    )
    expect(xmlToolDisclosureCovers(definitions, rebuiltCatalog)).toBe(true)
  })
})
