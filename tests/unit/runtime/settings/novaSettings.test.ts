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
})
