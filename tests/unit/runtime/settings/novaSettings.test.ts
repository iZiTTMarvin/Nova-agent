/**
 * novaSettings 持久化与损坏文件回退
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

  it.each([
    [{ permissionPolicy: 'ask' }, 'request_approval'],
    [{ permissionPolicy: 'auto' }, 'auto'],
    [{}, 'request_approval']
  ] as const)('旧权限设置迁移为默认权限模式', async (legacy, expected) => {
    const settingsPath = join(mockHome, '.nova', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )

    expect(loadNovaSettings().defaultPermissionMode).toBe(expected)
    saveNovaSettings({ loadThirdPartySkills: false })

    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    expect(persisted.defaultPermissionMode).toBe(expected)
    expect('permissionPolicy' in persisted).toBe(false)
  })

  it('完全访问未开放时拒绝写入默认设置', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    expect(() => saveNovaSettings({ defaultPermissionMode: 'full_access' }))
      .toThrow(/defaultPermissionMode/)
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

  it('代码索引默认关闭且可持久化布尔开关', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    expect(loadNovaSettings().codeIndexEnabled).toBe(false)
    saveNovaSettings({ codeIndexEnabled: true })
    expect(loadNovaSettings().codeIndexEnabled).toBe(true)
  })

  it('persistentShellSessions 默认开启且可持久化关闭', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    expect(loadNovaSettings().persistentShellSessions).toBe(true)
    saveNovaSettings({ persistentShellSessions: false })
    expect(loadNovaSettings().persistentShellSessions).toBe(false)
  })

  it('persistentShellSessions 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    expect(() => saveNovaSettings({ persistentShellSessions: 'yes' as unknown as boolean })).toThrow(
      /persistentShellSessions/
    )
  })

  it('旧 settings.json 含 defaultShellTimeout 时加载无错且该字段被丢弃', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    writeFileSync(
      join(mockHome, '.nova', 'settings.json'),
      JSON.stringify({ settingsVersion: 1, defaultShellTimeout: 60_000, theme: 'dark' }),
      'utf-8'
    )
    const s = loadNovaSettings()
    expect('defaultShellTimeout' in s).toBe(false)
    expect(s.theme).toBe('dark')
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

  it('记忆子能力默认随总开关开启', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    const s = loadNovaSettings()
    // 用户视角下记忆只有 memoryEnabled 一个按钮；子开关默认全 true，由总开关一键统控。
    expect(s.memoryCaptureEnabled).toBe(true)
    expect(s.memoryEpisodicSummaryEnabled).toBe(true)
    expect(s.memoryExtractEnabled).toBe(true)
  })

  it('采集设置可保存并读回', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    saveNovaSettings({
      memoryCaptureEnabled: true,
      memoryEpisodicSummaryEnabled: true
    })
    const s = loadNovaSettings()
    expect(s.memoryCaptureEnabled).toBe(true)
    expect(s.memoryEpisodicSummaryEnabled).toBe(true)
  })

  it('旧 settings.json 含 memoryAutoMergeEnabled 时加载无错且其余字段不丢', async () => {
    const { loadNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    writeFileSync(
      join(mockHome, '.nova', 'settings.json'),
      JSON.stringify({
        settingsVersion: 1,
        memoryEnabled: true,
        memoryAutoMergeEnabled: true,
        memorySearchLimit: 25,
        theme: 'dark'
      }),
      'utf-8'
    )
    const s = loadNovaSettings()
    // 已移除字段被忽略：不出现在结果里，也不触发旧 append 行为的开关
    expect('memoryAutoMergeEnabled' in s).toBe(false)
    // 其余字段原样保留
    expect(s.memoryEnabled).toBe(true)
    expect(s.memorySearchLimit).toBe(25)
    expect(s.theme).toBe('dark')
  })

  it('含 memoryAutoMergeEnabled 的旧文件往返保存后其他字段不丢失', async () => {
    const { loadNovaSettings, saveNovaSettings } = await import(
      '../../../../src/runtime/settings/novaSettings'
    )
    writeFileSync(
      join(mockHome, '.nova', 'settings.json'),
      JSON.stringify({ memoryEnabled: true, memoryAutoMergeEnabled: true, editorFontSize: 15 }),
      'utf-8'
    )
    saveNovaSettings({ memoryEnabled: false })
    const s = loadNovaSettings()
    expect(s.memoryEnabled).toBe(false)
    expect(s.editorFontSize).toBe(15)
    expect('memoryAutoMergeEnabled' in s).toBe(false)
  })

  it('memoryCaptureEnabled 非法值被 saveNovaSettings 拒绝', async () => {
    const { saveNovaSettings } = await import('../../../../src/runtime/settings/novaSettings')
    expect(() => saveNovaSettings({ memoryCaptureEnabled: 'yes' as unknown as boolean })).toThrow(
      /memoryCaptureEnabled/
    )
  })
})
