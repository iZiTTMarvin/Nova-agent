/**
 * novaSettings 持久化与损坏文件回退
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let mockHome: string

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => mockHome
  }
})

describe('novaSettings', () => {
  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'nova-home-'))
    mkdirSync(join(mockHome, '.nova'), { recursive: true })
  })

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true })
  })

  it('settings.json 损坏时回退默认值', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    writeFileSync(join(mockHome, '.nova', 'settings.json'), '{ broken', 'utf-8')
    expect(loadNovaSettings().loadThirdPartySkills).toBe(true)
  })

  it('saveNovaSettings 合并写入并可读回', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    saveNovaSettings({ loadThirdPartySkills: false })
    expect(loadNovaSettings().loadThirdPartySkills).toBe(false)
  })

  it('maxToolRounds 默认值为 100', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    expect(loadNovaSettings().maxToolRounds).toBe(100)
  })

  it('maxToolRounds 可保存并读回', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    saveNovaSettings({ maxToolRounds: 250 })
    expect(loadNovaSettings().maxToolRounds).toBe(250)
  })

  it('maxToolRounds 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    for (const bad of [0, 1001, 1.5, 'abc' as unknown as number]) {
      expect(() => saveNovaSettings({ maxToolRounds: bad })).toThrow(/maxToolRounds/)
    }
  })

  it('旧 settings.json 缺少 maxToolRounds 时迁移填充为 100', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    writeFileSync(
      join(mockHome, '.nova', 'settings.json'),
      JSON.stringify({ loadThirdPartySkills: true }),
      'utf-8'
    )
    expect(loadNovaSettings().maxToolRounds).toBe(100)
  })

  it('记忆设置默认值正确', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    const s = loadNovaSettings()
    expect(s.memoryEnabled).toBe(false)
    expect(s.memorySearchLimit).toBe(10)
    expect(s.memoryScoreFloor).toBe(0.15)
    expect(s.memoryReconcileOnSearch).toBe(false)
  })

  it('memorySearchLimit 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    for (const bad of [0, -1, 1.5, 'abc' as unknown as number]) {
      expect(() => saveNovaSettings({ memorySearchLimit: bad })).toThrow(/memorySearchLimit/)
    }
  })

  it('memoryScoreFloor 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    for (const bad of [-0.1, 1.1, 'x' as unknown as number]) {
      expect(() => saveNovaSettings({ memoryScoreFloor: bad })).toThrow(/memoryScoreFloor/)
    }
  })

  it('memoryEnabled 与 memoryReconcileOnSearch 可保存并读回', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    saveNovaSettings({
      memoryEnabled: false,
      memoryReconcileOnSearch: true,
      memorySearchLimit: 20,
      memoryScoreFloor: 0.25
    })
    const s = loadNovaSettings()
    expect(s.memoryEnabled).toBe(false)
    expect(s.memoryReconcileOnSearch).toBe(true)
    expect(s.memorySearchLimit).toBe(20)
    expect(s.memoryScoreFloor).toBe(0.25)
  })

  it('记忆子能力默认随总开关开启（autoMerge 除外）', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    const s = loadNovaSettings()
    // 用户视角下记忆只有 memoryEnabled 一个按钮；子开关默认全 true，
    // 由 memoryEnabled 一键统控；autoMerge 因改写 MEMORY.md 默认关。
    expect(s.memoryCaptureEnabled).toBe(true)
    expect(s.memoryEpisodicSummaryEnabled).toBe(true)
    expect(s.memoryExtractEnabled).toBe(true)
    expect(s.memoryAutoMergeEnabled).toBe(false)
  })

  it('P2 采集设置可保存并读回', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    saveNovaSettings({
      memoryCaptureEnabled: true,
      memoryEpisodicSummaryEnabled: true,
      memoryAutoMergeEnabled: false
    })
    const s = loadNovaSettings()
    expect(s.memoryCaptureEnabled).toBe(true)
    expect(s.memoryEpisodicSummaryEnabled).toBe(true)
    expect(s.memoryAutoMergeEnabled).toBe(false)
  })

  it('memoryCaptureEnabled 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    expect(() => saveNovaSettings({ memoryCaptureEnabled: 'yes' as unknown as boolean })).toThrow(
      /memoryCaptureEnabled/
    )
  })
})
