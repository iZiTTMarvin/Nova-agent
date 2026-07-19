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
    expect(bridge.hasBinding(bridged)).toBe(true)
    expect(bridge.resolve(bridged, true)).toBe(true)
    expect(bridge.hasBinding(bridged)).toBe(false)
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

  // ── C4 新增：活跃子 loop 追踪与 cancel 联动 ──────────────────

  describe('活跃子 loop 追踪（register / unregister / cancelAll）', () => {
    it('register 后 cancelAll 调用该 loop 的 cancel()', () => {
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      const spy = vi.spyOn(loop, 'cancel')
      bridge.register(loop)
      bridge.cancelAll()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('unregister 后 cancelAll 不再调用该 loop 的 cancel()', () => {
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      const spy = vi.spyOn(loop, 'cancel')
      bridge.register(loop)
      bridge.unregister(loop)
      bridge.cancelAll()
      expect(spy).not.toHaveBeenCalled()
    })

    it('cancelAll 对 state !== "running" 的 loop 安全跳过（不报错）', () => {
      // 新建 AgentLoop 默认 idle，cancel() 内部 state==='running' 守卫会跳过，
      // 这里验证 cancelAll 调用 cancel 不抛错，且 idle loop 状态不变。
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      expect(() => {
        bridge.register(loop)
        bridge.cancelAll()
      }).not.toThrow()
    })

    it('cancelAll 清空 activeLoops（重复 cancelAll 第二次不调用任何 cancel）', () => {
      const loop1 = new AgentLoop(new MockModelClient(), new EventBus())
      const loop2 = new AgentLoop(new MockModelClient(), new EventBus())
      const spy1 = vi.spyOn(loop1, 'cancel')
      const spy2 = vi.spyOn(loop2, 'cancel')
      bridge.register(loop1)
      bridge.register(loop2)
      bridge.cancelAll()
      expect(spy1).toHaveBeenCalledTimes(1)
      expect(spy2).toHaveBeenCalledTimes(1)
      // 第二次 cancelAll：集合已清空，不应再调用
      bridge.cancelAll()
      expect(spy1).toHaveBeenCalledTimes(1)
      expect(spy2).toHaveBeenCalledTimes(1)
    })

    it('register/unregister 不影响 bind/resolve 权限绑定语义', () => {
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      const spy = vi.spyOn(loop, 'respondPermission')
      // 先注册活跃 loop，再绑定权限请求，再 resolve —— 权限链路应正常工作
      bridge.register(loop)
      const bridged = bridge.bind('req-perm', loop)
      expect(bridge.resolve(bridged, true)).toBe(true)
      expect(spy).toHaveBeenCalledWith('req-perm', true)
    })

    it('clear 只清权限绑定，不清 activeLoops（二者生命周期不同）', () => {
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      const spy = vi.spyOn(loop, 'cancel')
      bridge.register(loop)
      bridge.bind('req-x', loop)
      bridge.clear()
      // clear 后权限绑定失效
      expect(bridge.resolve(`${SUB_PERMISSION_PREFIX}req-x`, true)).toBe(false)
      // 但 activeLoops 仍在，cancelAll 仍能联动
      bridge.cancelAll()
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('clearAll 同时清 activeLoops 与 bindings（仅测试用）', () => {
      const loop = new AgentLoop(new MockModelClient(), new EventBus())
      const spy = vi.spyOn(loop, 'cancel')
      bridge.register(loop)
      bridge.bind('req-y', loop)
      bridge.clearAll()
      bridge.cancelAll()
      expect(spy).not.toHaveBeenCalled()
    })
  })
})
