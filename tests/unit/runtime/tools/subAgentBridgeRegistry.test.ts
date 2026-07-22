/**
 * 子代理桥接登记表单测：按 run 隔离、跨 run 路由、cancelAllForRun。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  subAgentBridgeRegistry,
  SUB_PERMISSION_PREFIX,
  clearSubAgentPermissionBindings,
  defaultSubAgentPermissionBridge
} from '../../../../src/runtime/tools/subAgentBridge'
import { EventBus } from '../../../../src/runtime/agent'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { AgentLoop } from '../../../../src/runtime/agent'

function makeLoop(): AgentLoop {
  return new AgentLoop(new MockModelClient(), new EventBus())
}

describe('SubAgentBridgeRegistry', () => {
  beforeEach(() => {
    subAgentBridgeRegistry.resetForTests()
    defaultSubAgentPermissionBridge.clearAll()
    clearSubAgentPermissionBindings()
  })

  it('getOrCreate 为同一 run 返回同一实例', () => {
    const a1 = subAgentBridgeRegistry.getOrCreate('runA')
    const a2 = subAgentBridgeRegistry.getOrCreate('runA')
    expect(a1).toBe(a2)
    const b = subAgentBridgeRegistry.getOrCreate('runB')
    expect(b).not.toBe(a1)
  })

  it('hasBinding / resolve 跨 run 扫描路由到持有者', () => {
    const loop = makeLoop()
    const bridge = subAgentBridgeRegistry.getOrCreate('runA')
    const bridgedId = bridge.bind('raw_1', loop)
    expect(bridgedId.startsWith(SUB_PERMISSION_PREFIX)).toBe(true)

    expect(subAgentBridgeRegistry.hasBinding(bridgedId)).toBe(true)
    expect(subAgentBridgeRegistry.hasBinding('sub:other')).toBe(false)

    const spy = vi.spyOn(loop, 'respondPermission')
    const routed = subAgentBridgeRegistry.resolve(bridgedId, true)
    expect(routed).toBe(true)
    expect(spy).toHaveBeenCalledWith('raw_1', true)
  })

  it('cancelAllForRun 只终止该 run 名下的子循环', () => {
    const loopA = makeLoop()
    const loopB = makeLoop()
    const spyA = vi.spyOn(loopA, 'cancel')
    const spyB = vi.spyOn(loopB, 'cancel')

    const bridgeA = subAgentBridgeRegistry.getOrCreate('runA')
    const bridgeB = subAgentBridgeRegistry.getOrCreate('runB')
    bridgeA.register(loopA)
    bridgeB.register(loopB)

    subAgentBridgeRegistry.cancelAllForRun('runA')
    expect(spyA).toHaveBeenCalled()
    expect(spyB).not.toHaveBeenCalled()
  })

  it('release 回收该 run 的桥接，hasBinding 不再命中', () => {
    const loop = makeLoop()
    const bridge = subAgentBridgeRegistry.getOrCreate('runA')
    const bridgedId = bridge.bind('raw_1', loop)
    expect(subAgentBridgeRegistry.hasBinding(bridgedId)).toBe(true)

    subAgentBridgeRegistry.release('runA')
    expect(subAgentBridgeRegistry.get('runA')).toBeUndefined()
    expect(subAgentBridgeRegistry.hasBinding(bridgedId)).toBe(false)
  })

  it('不同 run 的 requestId 互不串扰', () => {
    const loopA = makeLoop()
    const loopB = makeLoop()
    const bridgeA = subAgentBridgeRegistry.getOrCreate('runA')
    const bridgeB = subAgentBridgeRegistry.getOrCreate('runB')
    const idA = bridgeA.bind('raw', loopA)
    const idB = bridgeB.bind('raw', loopB)

    const spyA = vi.spyOn(loopA, 'respondPermission')
    const spyB = vi.spyOn(loopB, 'respondPermission')

    // resolve idA 只应命中 loopA
    expect(subAgentBridgeRegistry.resolve(idA, true)).toBe(true)
    expect(spyA).toHaveBeenCalledWith('raw', true)
    expect(spyB).not.toHaveBeenCalled()
    // idB 仍可路由
    expect(subAgentBridgeRegistry.resolve(idB, false)).toBe(true)
    expect(spyB).toHaveBeenCalledWith('raw', false)
  })
})
