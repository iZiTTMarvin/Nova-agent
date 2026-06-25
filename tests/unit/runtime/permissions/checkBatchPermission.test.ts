import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { PermissionRule } from '../../../../src/runtime/permissions/PermissionRule'

describe('checkBatchPermission 批量权限校验', () => {
  let eventBus: EventBus
  let client: MockModelClient
  let loop: AgentLoop
  let pm: PermissionManager

  beforeEach(() => {
    client = new MockModelClient()
    eventBus = new EventBus()
    loop = new AgentLoop(client, eventBus)
    pm = new PermissionManager()
    loop.setPermissionManager(pm)
  })

  it('如果所有 bash 命令本地规则匹配为 allow 或 deny，应该直接返回而不弹窗', async () => {
    // 注入项目规则：允许 ls，拒绝 rm
    const rules: PermissionRule[] = [
      {
        id: 'rule-1',
        toolName: 'bash',
        behavior: 'allow',
        scope: 'project',
        projectPath: '/test-project',
        commandPrefix: 'ls',
        createdAt: Date.now()
      },
      {
        id: 'rule-2',
        toolName: 'bash',
        behavior: 'deny',
        scope: 'project',
        projectPath: '/test-project',
        commandPrefix: 'rm',
        createdAt: Date.now()
      }
    ]
    pm.setRules(rules)
    pm.setCurrentProjectPath('/test-project')

    const items = [
      { toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls -la' } },
      { toolCallId: 'call-2', toolName: 'bash', args: { command: 'rm -rf /' } }
    ]

    // 监听是否触发弹窗事件
    const permissionRequested = vi.fn()
    eventBus.on((event) => {
      if (event.type === 'permission_request') {
        permissionRequested()
      }
    })

    const results = await loop.checkBatchPermission(items, 'msg-1')

    // 应该不触发弹窗事件
    expect(permissionRequested).not.toHaveBeenCalled()

    // 校验结果应该直接对应
    expect(results.get('call-1')).toEqual({ allowed: true, reason: '' })
    expect(results.get('call-2')?.allowed).toBe(false)
    expect(results.get('call-2')?.reason).toContain('rule-2')
  })

  it('有需要 ask 的命令时，应该合并触发 permission_request 并在用户同意后通过', async () => {
    // default 模式下常规 bash 命令是 ask
    loop.setMode('default')

    const items = [
      { toolCallId: 'call-1', toolName: 'bash', args: { command: 'git status' } },
      { toolCallId: 'call-2', toolName: 'bash', args: { command: 'npm install' } }
    ]

    let capturedRequestId = ''
    eventBus.on((event) => {
      if (event.type === 'permission_request') {
        capturedRequestId = event.requestId
        expect(event.commands).toEqual(['git status', 'npm install'])
        
        // 模拟用户允许
        setTimeout(() => {
          loop.respondPermission(event.requestId, true)
        }, 10)
      }
    })

    const results = await loop.checkBatchPermission(items, 'msg-2')

    expect(capturedRequestId).toBeTruthy()
    expect(results.get('call-1')).toEqual({ allowed: true, reason: '' })
    expect(results.get('call-2')).toEqual({ allowed: true, reason: '' })
  })

  it('有需要 ask 的命令时，用户拒绝则整批被拒', async () => {
    loop.setMode('default')

    const items = [
      { toolCallId: 'call-1', toolName: 'bash', args: { command: 'git status' } },
      { toolCallId: 'call-2', toolName: 'bash', args: { command: 'npm install' } }
    ]

    eventBus.on((event) => {
      if (event.type === 'permission_request') {
        // 模拟用户拒绝
        setTimeout(() => {
          loop.respondPermission(event.requestId, false)
        }, 10)
      }
    })

    const results = await loop.checkBatchPermission(items, 'msg-3')

    expect(results.get('call-1')?.allowed).toBe(false)
    expect(results.get('call-2')?.allowed).toBe(false)
    expect(results.get('call-1')?.reason).toContain('拒绝')
    expect(results.get('call-2')?.reason).toContain('拒绝')
  })
})
