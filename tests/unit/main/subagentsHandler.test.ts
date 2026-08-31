/**
 * subagentsHandler — IPC 边界与 presetStore 的真实文件闭环。
 * secureIpc 被替换为注册捕获，其余（store、codec、fs）全部真实运行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SubAgentSpec } from '../../../src/shared/settings/types'

const { state, handlers } = vi.hoisted(() => ({
  state: { novaHome: '', workspace: '' },
  handlers: new Map<string, (event: unknown, params: unknown) => Promise<unknown>>()
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, fn: (event: unknown, params: unknown) => Promise<unknown>) => {
    handlers.set(channel, fn)
  }
}))
vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  getNovaHomeDir: () => state.novaHome
}))

import { registerSubagentsHandler } from '../../../src/main/ipc/subagentsHandler'

registerSubagentsHandler()

function invoke<T>(channel: string, params: unknown): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler ${channel} 未注册`)
  return fn({}, params) as Promise<T>
}

function draft(overrides: Partial<SubAgentSpec> = {}): SubAgentSpec {
  return {
    id: 'my-helper',
    name: '我的助手',
    description: 'helper',
    enabled: true,
    allowedTools: ['read'],
    prompt: 'do work',
    ...overrides
  }
}

async function expectReject(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toThrow(pattern)
}

describe('subagentsHandler IPC（global/project 层级语义）', () => {
  beforeEach(() => {
    state.novaHome = mkdtempSync(join(tmpdir(), 'nova-handler-home-'))
    state.workspace = mkdtempSync(join(tmpdir(), 'nova-handler-ws-'))
  })

  afterEach(() => {
    rmSync(state.novaHome, { recursive: true, force: true })
    rmSync(state.workspace, { recursive: true, force: true })
  })

  it('list 返回内置项与空诊断，身份使用稳定 ID', async () => {
    const result = await invoke<{
      items: Array<{ id: string; builtin: boolean }>
      diagnostics: unknown[]
      tools: Array<{ name: string; effects: string[]; selectable: boolean }>
    }>('subagents:list', {})
    expect(result.items.map(i => i.id).sort()).toEqual(['code', 'explore', 'general-purpose', 'review'])
    expect(result.items.every(i => i.builtin)).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.tools.find(tool => tool.name === 'read')).toEqual({
      name: 'read',
      effects: ['filesystem.read'],
      selectable: true
    })
    expect(result.tools.find(tool => tool.name === 'task')?.selectable).toBe(false)
  })

  it('创建到 global 后 list 可见，文件落在 ~/.nova/subagents.json', async () => {
    const saved = await invoke<SubAgentSpec & { origin: string }>('subagents:create', {
      preset: draft(),
      location: 'global',
      workspaceRoot: null
    })
    expect(saved.origin).toBe('global')
    const onDisk = JSON.parse(
      readFileSync(join(state.novaHome, 'subagents.json'), 'utf-8')
    )
    expect(onDisk.version).toBe(2)
    expect(onDisk.presets).toHaveLength(1)
    const list = await invoke<{ items: Array<{ id: string; origin: string }> }>(
      'subagents:list',
      { workspaceRoot: state.workspace }
    )
    const item = list.items.find(i => i.id === 'my-helper')
    expect(item?.origin).toBe('global')
  })

  it('同层重复创建拒绝而非静默更新', async () => {
    await invoke('subagents:create', { preset: draft(), location: 'global', workspaceRoot: null })
    await expectReject(
      /已存在同 ID/,
      () => invoke('subagents:create', {
        preset: draft({ prompt: 'second write' }),
        location: 'global',
        workspaceRoot: null
      })
    )
    const onDisk = JSON.parse(
      readFileSync(join(state.novaHome, 'subagents.json'), 'utf-8')
    )
    expect(onDisk.presets[0].prompt).toBe('do work')
  })

  it('project 同 ID 创建即显式覆盖；删除 project 后 global 恢复显示', async () => {
    await invoke('subagents:create', { preset: draft(), location: 'global', workspaceRoot: null })
    await invoke('subagents:create', {
      preset: draft({ name: '项目覆盖版' }),
      location: 'project',
      workspaceRoot: state.workspace
    })
    const merged = await invoke<{ items: Array<{ id: string; origin: string; name: string }> }>(
      'subagents:list',
      { workspaceRoot: state.workspace }
    )
    const override = merged.items.find(i => i.id === 'my-helper')
    expect(override).toMatchObject({ origin: 'project', name: '项目覆盖版' })

    await invoke('subagents:delete', {
      id: 'my-helper',
      location: 'project',
      workspaceRoot: state.workspace
    })
    const afterDelete = await invoke<{ items: Array<{ id: string; origin: string }> }>(
      'subagents:list',
      { workspaceRoot: state.workspace }
    )
    expect(afterDelete.items.find(i => i.id === 'my-helper')?.origin).toBe('global')
  })

  it('删除只影响目标层级：global 存在时删 project 不连带 global', async () => {
    await invoke('subagents:create', { preset: draft(), location: 'global', workspaceRoot: null })
    await expectReject(
      /该层级不存在/,
      () => invoke('subagents:delete', {
        id: 'my-helper',
        location: 'project',
        workspaceRoot: state.workspace
      })
    )
    const globalFile = JSON.parse(
      readFileSync(join(state.novaHome, 'subagents.json'), 'utf-8')
    )
    expect(globalFile.presets).toHaveLength(1)
  })

  it('无 workspace 的 project 请求被拒绝', async () => {
    await expectReject(
      /需要先打开工作区/,
      () => invoke('subagents:create', { preset: draft(), location: 'project', workspaceRoot: null })
    )
  })

  it.each(['create', 'update', 'set-enabled', 'delete'])(
    '内置 ID 在 %s 命令的领域边界被拒绝',
    async (command) => {
      const location = { location: 'global' as const, workspaceRoot: null }
      if (command === 'create') {
        await expectReject(/内置保留身份|不可占用/, () =>
          invoke('subagents:create', { preset: draft({ id: 'explore', name: 'explore' }), ...location })
        )
      } else if (command === 'update') {
        await expectReject(/内置保留身份|不可占用/, () =>
          invoke('subagents:update', { id: 'explore', preset: draft({ id: 'explore', name: 'explore' }), ...location })
        )
      } else if (command === 'set-enabled') {
        await expectReject(/内置/, () =>
          invoke('subagents:set-enabled', { id: 'explore', enabled: false, ...location })
        )
      } else {
        await expectReject(/内置/, () =>
          invoke('subagents:delete', { id: 'explore', ...location })
        )
      }
    }
  )

  it('启停命令写回目标层级并反映在 list', async () => {
    await invoke('subagents:create', { preset: draft(), location: 'global', workspaceRoot: null })
    const updated = await invoke<{ enabled: boolean }>('subagents:set-enabled', {
      id: 'my-helper',
      enabled: false,
      location: 'global',
      workspaceRoot: null
    })
    expect(updated.enabled).toBe(false)
    const list = await invoke<{ items: Array<{ id: string; enabled: boolean }> }>(
      'subagents:list',
      { workspaceRoot: null }
    )
    expect(list.items.find(i => i.id === 'my-helper')?.enabled).toBe(false)
  })

  it('损坏的全局文件返回诊断而非伪装无配置，且拒绝在其上写入', async () => {
    writeFileSync(join(state.novaHome, 'subagents.json'), '{ not json', 'utf-8')
    const list = await invoke<{
      items: Array<{ id: string; builtin: boolean }>
      diagnostics: Array<{ code: string; location: string }>
    }>('subagents:list', { workspaceRoot: null })
    expect(list.items.every(i => i.builtin)).toBe(true)
    expect(list.diagnostics).toMatchObject([
      { code: 'document_unreadable', location: 'global' }
    ])
    await expectReject(
      /已损坏/,
      () => invoke('subagents:create', { preset: draft(), location: 'global', workspaceRoot: null })
    )
  })

  it('v1 文档经 IPC list 迁移为稳定 ID，重命名不改变 ID 与覆盖语义', async () => {
    writeFileSync(
      join(state.novaHome, 'subagents.json'),
      JSON.stringify({
        version: 1,
        revision: 3,
        presets: [
          {
            name: 'legacy helper',
            description: 'old',
            allowedTools: ['read'],
            prompt: 'old prompt'
          }
        ]
      }),
      'utf-8'
    )
    const list = await invoke<{ items: Array<{ id: string; name: string }> }>(
      'subagents:list',
      { workspaceRoot: null }
    )
    const migrated = list.items.find(i => i.id === 'legacy-helper')
    expect(migrated?.name).toBe('legacy helper')

    await invoke('subagents:update', {
      id: 'legacy-helper',
      preset: draft({ id: 'legacy-helper', name: '改过的名字' }),
      location: 'global',
      workspaceRoot: null
    })
    const after = await invoke<{ items: Array<{ id: string; name: string }> }>(
      'subagents:list',
      { workspaceRoot: null }
    )
    const renamed = after.items.find(i => i.id === 'legacy-helper')
    expect(renamed?.name).toBe('改过的名字')
    // 首次显式写入把 v1 文档物化为 v2，且保留迁移得出的稳定 ID
    const onDisk = JSON.parse(
      readFileSync(join(state.novaHome, 'subagents.json'), 'utf-8')
    )
    expect(onDisk.version).toBe(2)
    expect(onDisk.presets).toHaveLength(1)
    expect(onDisk.presets[0].id).toBe('legacy-helper')
  })

  it('非法模型绑定与非法字段在保存边界被拒绝并给出可操作信息', async () => {
    await expectReject(/旧 model 引用不可保存/, () =>
      invoke('subagents:create', {
        preset: draft({
          model: { providerId: 'p', modelId: 'm' } as unknown as SubAgentSpec['model']
        }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/reasoningEffort/, () =>
      invoke('subagents:create', {
        preset: draft({
          model: { providerId: 'p', modelEntryId: 'e', reasoningEffort: 'extreme' } as unknown as SubAgentSpec['model']
        }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/allowedTools/, () =>
      invoke('subagents:create', {
        preset: draft({ allowedTools: ['   '] }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/未知工具/, () =>
      invoke('subagents:create', {
        preset: draft({ allowedTools: ['made_up_tool'] }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/不可授予子代理/, () =>
      invoke('subagents:create', {
        preset: draft({ allowedTools: ['task'] }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/不可授予子代理/, () =>
      invoke('subagents:create', {
        preset: draft({ allowedTools: ['invoke_skill'] }),
        location: 'global',
        workspaceRoot: null
      })
    )
    await expectReject(/\.id/, () =>
      invoke('subagents:create', {
        preset: draft({ id: 'Bad ID!' }),
        location: 'global',
        workspaceRoot: null
      })
    )
  })
})
