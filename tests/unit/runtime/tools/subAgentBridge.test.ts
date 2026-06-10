import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import {
  SubAgentPermissionBridge,
  SUB_PERMISSION_PREFIX,
  clearSubAgentPermissionBindings
} from '../../../../src/runtime/tools/subAgentBridge'

describe('subAgentBridge', () => {
  let bridge: SubAgentPermissionBridge

  beforeEach(() => {
    clearSubAgentPermissionBindings()
    bridge = new SubAgentPermissionBridge()
  })

  it('bind 返回 sub: 前缀 requestId，resolve 用原始 id 回调子循环', () => {
    const loop = new AgentLoop(new MockModelClient(), new EventBus())
    const spy = vi.spyOn(loop, 'respondPermission')
    const bridged = bridge.bind('req-1', loop)
    expect(bridged).toBe(`${SUB_PERMISSION_PREFIX}req-1`)
    expect(bridge.resolve(bridged, true)).toBe(true)
    expect(spy).toHaveBeenCalledWith('req-1', true)
    expect(bridge.resolve(bridged, true)).toBe(false)
  })

  it('无 sub: 前缀的 requestId 不进入子循环（父命名空间）', () => {
    const loop = new AgentLoop(new MockModelClient(), new EventBus())
    const spy = vi.spyOn(loop, 'respondPermission')
    bridge.bind('parent-same-id', loop)
    expect(bridge.resolve('parent-same-id', true)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('子代理 sub: 前缀与父 requestId 同名时不冲突', () => {
    const subLoop = new AgentLoop(new MockModelClient(), new EventBus())
    const subSpy = vi.spyOn(subLoop, 'respondPermission')

    const sharedId = 'collision-uuid'
    const bridged = bridge.bind(sharedId, subLoop)

    // 父 IPC 用裸 id → 不进子循环
    expect(bridge.resolve(sharedId, true)).toBe(false)
    expect(subSpy).not.toHaveBeenCalled()

    // UI 用 sub: 前缀 id → 正确路由到子循环
    expect(bridge.resolve(bridged, true)).toBe(true)
    expect(subSpy).toHaveBeenCalledWith(sharedId, true)
  })

  it('clearForLoop 清除指定子循环的挂起绑定', () => {
    const loop = new AgentLoop(new MockModelClient(), new EventBus())
    const bridged = bridge.bind('req-a', loop)
    bridge.clearForLoop(loop)
    expect(bridge.resolve(bridged, true)).toBe(false)
  })

  it('未知 bridged requestId 返回 false', () => {
    expect(bridge.resolve(`${SUB_PERMISSION_PREFIX}missing`, true)).toBe(false)
  })
})
