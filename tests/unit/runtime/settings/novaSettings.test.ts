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
})
