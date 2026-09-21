/**
 * 浏览器工具权限描述与写能力推断。无 descriptor 时权限解析直接失败。
 */
import { describe, expect, it } from 'vitest'
import {
  getToolPermissionDescriptor,
  isToolAvailableWithinCapabilityCeiling,
  toolHasWriteCapability
} from '../../../../src/shared/permissions/toolEffects'

const BROWSER_READ = ['browser_observe', 'browser_capture'] as const
const BROWSER_WRITE = ['browser_open', 'browser_act', 'browser_close'] as const

describe('浏览器工具权限描述', () => {
  it.each(BROWSER_READ)('%s 为 network.read', (name) => {
    expect(getToolPermissionDescriptor(name)).toEqual({
      effects: ['network.read'],
      pathScope: 'none'
    })
  })

  it.each(BROWSER_WRITE)('%s 为 network.write', (name) => {
    expect(getToolPermissionDescriptor(name)).toEqual({
      effects: ['network.write'],
      pathScope: 'none'
    })
  })
})

describe('子代理写能力推断', () => {
  it('网络写入视为写能力，网络读取不抬升', () => {
    for (const name of BROWSER_WRITE) {
      expect(toolHasWriteCapability(name)).toBe(true)
    }
    for (const name of BROWSER_READ) {
      expect(toolHasWriteCapability(name)).toBe(false)
    }
    expect(toolHasWriteCapability('web_search')).toBe(false)
    expect(toolHasWriteCapability('web_fetch')).toBe(false)
    expect(toolHasWriteCapability('write')).toBe(true)
    expect(toolHasWriteCapability('bash')).toBe(true)
  })
})

describe('只读能力上限', () => {
  it('放行观察/截图，拒绝打开/操作/关闭', () => {
    for (const name of BROWSER_READ) {
      expect(isToolAvailableWithinCapabilityCeiling(name, 'read_only')).toBe(true)
    }
    for (const name of BROWSER_WRITE) {
      expect(isToolAvailableWithinCapabilityCeiling(name, 'read_only')).toBe(false)
    }
  })

  it('无上限时不因浏览器工具收窄', () => {
    for (const name of [...BROWSER_READ, ...BROWSER_WRITE]) {
      expect(isToolAvailableWithinCapabilityCeiling(name, null)).toBe(true)
    }
  })
})
