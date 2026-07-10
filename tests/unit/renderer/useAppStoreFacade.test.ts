/**
 * T6-2 / T4-1：React 合并订阅已删除；hook 调用必须抛错。
 * 静态 getState/setState 仍可用（测试兼容），新测试请直接用子 store。
 */
import { describe, expect, it } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

describe('useAppStore 非 React facade（T6-2）', () => {
  it('误当作 React hook 调用时抛错，强制改用子 store', () => {
    expect(() => {
      useAppStore()
    }).toThrow(/已移除 React 合并订阅/)
  })

  it('getState/setState 仍可读写合并视图（测试兼容）', () => {
    resetChatStoreForTests()
    useAppStore.setState({ currentSessionId: 'sess_t6' })
    expect(useAppStore.getState().currentSessionId).toBe('sess_t6')
    expect(useChatStore.getState().currentSessionId).toBe('sess_t6')
  })

  it('生产路径应直接写子 store，不经 facade 合并订阅', () => {
    resetChatStoreForTests()
    useChatStore.setState({ currentSessionId: 'sess_direct' })
    expect(useChatStore.getState().currentSessionId).toBe('sess_direct')
    expect(useAppStore.getState().currentSessionId).toBe('sess_direct')
  })
})
