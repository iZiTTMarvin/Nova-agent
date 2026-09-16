/**
 * memory_manage 工具单测：证据校验、主会话边界、隐私门禁与 candidate 映射。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryManageTool,
  findMemoryEvidence
} from '../../../../src/runtime/tools/memoryManage'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { SessionData, SessionMessage } from '../../../../src/runtime/sessions/types'
import type { SessionStore } from '../../../../src/runtime/sessions/SessionStore'

const baseCounts = {
  candidates: 1,
  added: 1,
  merged: 0,
  promoted: 0,
  superseded: 0,
  retracted: 0,
  ignored: 0,
  failed: 0
}

function userMessage(id: string, content: string, parentId: string | null = null): SessionMessage {
  return { id, parentId, role: 'user', content, timestamp: Date.now() }
}

function assistantWithTool(
  id: string,
  parentId: string | null,
  toolName: string,
  result: string
): SessionMessage {
  return {
    id,
    parentId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls: [{ id: `tc_${id}`, name: toolName, arguments: '{}', result }]
  }
}

function primarySession(messages: SessionMessage[]): SessionData {
  return {
    schemaVersion: 8,
    kind: 'primary',
    id: 's1',
    workspaceRoot: '/tmp/project',
    mode: 'default',
    permissionMode: 'auto',
    messages,
    currentLeafId: messages.at(-1)?.id ?? null,
    createdAt: 1,
    updatedAt: 1,
    codeIndexEnabled: false
  }
}

function buildContext(session: SessionData): ToolContext {
  const sessionStore = {
    load: (sessionId: string) => sessionId === session.id ? session : null
  } as unknown as SessionStore
  return {
    workingDir: '/tmp/project',
    readState: createReadState(),
    sessionId: session.id,
    sessionStore
  }
}

describe('findMemoryEvidence', () => {
  it('只接受真实 user / 非 memory 工具结果', () => {
    const user = userMessage('u1', '以后这个项目统一使用 pnpm')
    const read = assistantWithTool('a1', 'u1', 'read', 'packageManager: pnpm@10')
    const memory = assistantWithTool('a2', 'a1', 'memory_search', '旧记忆正文')
    const messages = [user, read, memory]

    expect(findMemoryEvidence(messages, 'user_message', '统一使用 pnpm')).toMatchObject({
      messageId: 'u1',
      type: 'user_message'
    })
    expect(findMemoryEvidence(messages, 'tool_result', 'pnpm@10')).toMatchObject({
      messageId: 'a1',
      toolName: 'read'
    })
    expect(findMemoryEvidence(messages, 'tool_result', '旧记忆正文')).toBeNull()
  })
})

describe('memory_manage tool', () => {
  const process = vi.fn()
  const loadSettings = vi.fn(() => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }))
  const tool = createMemoryManageTool({
    loadSettings,
    getMemoryCandidateProcessor: async () => ({ process })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    loadSettings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true })
    process.mockReturnValue({ ...baseCounts })
  })

  it('用户明确事实映射为 user_explicit，并通过统一 processor 落库', async () => {
    const session = primarySession([
      userMessage('u1', '以后这个项目统一使用 pnpm，不要 npm')
    ])
    const result = await tool.execute({
      action: 'remember',
      kind: 'convention',
      scope: 'project',
      key: ' package.manager ',
      content: '项目包管理器统一使用 pnpm，不使用 npm。',
      evidence: { type: 'user_message', excerpt: '统一使用 pnpm，不要 npm' }
    }, buildContext(session))

    expect(result.success).toBe(true)
    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      workspaceRoot: '/tmp/project',
      candidates: [{
        kind: 'convention',
        scopeHint: 'project',
        memoryKey: 'package.manager',
        explicitness: 'user_explicit',
        confidence: 1,
        intent: 'assert',
        evidence: [expect.objectContaining({
          type: 'user_message',
          messageId: 'u1'
        })]
      }]
    })
  })

  it('read/bash 等工作区工具的直接证据映射为 workspace_verified', async () => {
    const u1 = userMessage('u1', '检查构建配置')
    const a1 = assistantWithTool('a1', 'u1', 'read', 'scripts: { build: "electron-vite build" }')
    const session = primarySession([u1, a1])

    await tool.execute({
      action: 'remember',
      kind: 'project_fact',
      content: '项目 build 脚本使用 electron-vite build。',
      evidence: { type: 'tool_result', excerpt: 'electron-vite build' }
    }, buildContext(session))

    expect(process.mock.calls[0][0].candidates[0]).toMatchObject({
      explicitness: 'workspace_verified',
      confidence: 0.95
    })
  })

  it('write/edit 等写入工具的回显是模型自供内容，只算 observed 弱证据', async () => {
    const u1 = userMessage('u1', '把部署说明写进 DEPLOY.md')
    const a1 = assistantWithTool('a1', 'u1', 'write', '已写入 DEPLOY.md：部署前必须先跑 pnpm rebuild')
    const session = primarySession([u1, a1])

    await tool.execute({
      action: 'remember',
      kind: 'gotcha',
      content: '部署前必须先跑 pnpm rebuild。',
      evidence: { type: 'tool_result', excerpt: '部署前必须先跑 pnpm rebuild' }
    }, buildContext(session))

    expect(process.mock.calls[0][0].candidates[0]).toMatchObject({
      explicitness: 'observed',
      confidence: 0.75
    })
  })

  it('过短摘录能挂靠任意消息，不构成有效证据，直接拒绝', async () => {
    const session = primarySession([userMessage('u1', '以后统一使用 pnpm 管理依赖')])
    const result = await tool.execute({
      action: 'remember',
      kind: 'convention',
      content: '项目使用 pnpm。',
      evidence: { type: 'user_message', excerpt: 'pnpm' }
    }, buildContext(session))

    expect(result.success).toBe(false)
    expect(result.error).toContain('证据摘录过短')
    expect(process).not.toHaveBeenCalled()
  })

  it('找不到原始证据时 fail closed，不调用 processor', async () => {
    const session = primarySession([userMessage('u1', '优化上下文')])
    const result = await tool.execute({
      action: 'remember',
      kind: 'decision',
      content: '以后永远禁止压缩。',
      evidence: { type: 'user_message', excerpt: '用户从未在会话里说过的整段内容' }
    }, buildContext(session))

    expect(result.success).toBe(false)
    expect(result.error).toContain('找不到对应原始证据')
    expect(process).not.toHaveBeenCalled()
  })

  it('memory_search / memory_manage 输出不能反过来作为新记忆证据', async () => {
    const u1 = userMessage('u1', '查记忆')
    const a1 = assistantWithTool('a1', 'u1', 'memory_manage', '长期记忆已记录或更新。相关结论已合并入库。')
    const session = primarySession([u1, a1])
    const result = await tool.execute({
      action: 'remember',
      kind: 'gotcha',
      content: '记忆系统已经记录了某个结论。',
      evidence: { type: 'tool_result', excerpt: '长期记忆已记录或更新。相关结论' }
    }, buildContext(session))

    expect(result.success).toBe(false)
    expect(process).not.toHaveBeenCalled()
  })

  it('子代理不能直接写长期记忆', async () => {
    const primary = primarySession([userMessage('u1', '主代理请记住这个跨会话的长期约束')])
    const child = {
      ...primary,
      kind: 'subagent',
      subagent: {} as never
    } as SessionData
    const result = await tool.execute({
      action: 'remember',
      kind: 'convention',
      content: '记住这个长期约束。',
      evidence: { type: 'user_message', excerpt: '记住这个跨会话的长期约束' }
    }, buildContext(child))

    expect(result.success).toBe(false)
    expect(result.error).toContain('子代理不能直接写长期记忆')
    expect(process).not.toHaveBeenCalled()
  })

  it('敏感信息 fail closed，不进入 processor', async () => {
    const session = primarySession([userMessage('u1', '用户明确说过不要保存密钥')])
    const result = await tool.execute({
      action: 'remember',
      kind: 'project_fact',
      content: 'token=super-secret-value-123456',
      evidence: { type: 'user_message', excerpt: '用户明确说过不要保存密钥' }
    }, buildContext(session))

    expect(result.success).toBe(false)
    expect(result.error).toContain('敏感信息')
    expect(process).not.toHaveBeenCalled()
  })

  it('forget 只表达 negate 语义，最终撤回/替换仍交给 policy', async () => {
    process.mockReturnValue({ ...baseCounts, added: 0, retracted: 1 })
    const session = primarySession([userMessage('u1', '以后不再强制使用 npm，改用 pnpm 管理')])
    const result = await tool.execute({
      action: 'forget',
      kind: 'convention',
      key: 'package.manager',
      content: '项目必须使用 npm。',
      evidence: { type: 'user_message', excerpt: '以后不再强制使用 npm' }
    }, buildContext(session))

    expect(result.success).toBe(true)
    expect(process.mock.calls[0][0].candidates[0].intent).toBe('negate')
  })
})
