import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { SubAgentSpec } from '../../../../src/shared/settings/types'

const { state } = vi.hoisted(() => ({ state: { novaHome: '' } }))

vi.mock('../../../../src/runtime/settings/novaSettings', () => ({
  getNovaHomeDir: () => state.novaHome
}))

import {
  createPreset,
  deletePreset,
  getSubAgentSpecFromStore,
  listCustomPresets,
  listCustomPresetView,
  loadMergedCustomPresets,
  setPresetEnabled,
  SubagentPresetCommandError,
  updatePreset
} from '../../../../src/runtime/subagents/presetStore'

function preset(overrides: Partial<SubAgentSpec> = {}): SubAgentSpec {
  return {
    id: 'alpha',
    name: 'Alpha',
    description: 'first',
    enabled: true,
    allowedTools: ['read'],
    prompt: 'work',
    ...overrides
  }
}

function globalFile(): string {
  return join(state.novaHome, 'subagents.json')
}

describe('presetStore（真实文件读写）', () => {
  let workspace: string

  beforeEach(() => {
    state.novaHome = mkdtempSync(join(tmpdir(), 'nova-preset-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'nova-preset-ws-'))
  })

  afterEach(() => {
    rmSync(state.novaHome, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  describe('当前版本往返', () => {
    it('新格式读写往返稳定，文档携带 version 2 与递增 revision', () => {
      createPreset(preset(), 'global')
      const first = JSON.parse(readFileSync(globalFile(), 'utf-8'))
      expect(first).toMatchObject({ version: 2, revision: 1 })
      updatePreset('alpha', preset({ name: 'Alpha 改名' }), 'global')
      const second = JSON.parse(readFileSync(globalFile(), 'utf-8'))
      expect(second.revision).toBe(2)
      expect(listCustomPresets()[0]).toEqual({ ...preset(), name: 'Alpha 改名' })
    })

    it('重复读取同一文档结果一致，不重写磁盘', () => {
      createPreset(preset(), 'global')
      const before = readFileSync(globalFile(), 'utf-8')
      const firstView = listCustomPresetView()
      const secondView = listCustomPresetView()
      expect(secondView).toEqual(firstView)
      expect(readFileSync(globalFile(), 'utf-8')).toBe(before)
    })
  })

  describe('旧版迁移（单一入口）', () => {
    it('v1 文档迁移为确定性稳定 ID，enabled=true，legacy 模型引用保留为只读', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({
          version: 1,
          revision: 7,
          presets: [
            {
              name: 'My Helper',
              description: 'd',
              allowedTools: ['read'],
              prompt: 'p',
              model: { providerId: 'p1', modelId: 'api-x' }
            },
            { name: 'my helper', description: 'd2', allowedTools: ['read'], prompt: 'p2' }
          ]
        }),
        'utf-8'
      )
      const { presets } = listCustomPresetView()
      expect(presets.map(e => e.preset.id)).toEqual(['my-helper', 'my-helper-2'])
      expect(presets[0].preset.enabled).toBe(true)
      expect(presets[0].preset.model).toEqual({ providerId: 'p1', modelId: 'api-x' })
    })

    it('纯中文名迁移到兜底基底并确定性去重', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({
          version: 1,
          revision: 0,
          presets: [
            { name: '你好', description: 'a', allowedTools: ['read'], prompt: 'p' },
            { name: '世界', description: 'b', allowedTools: ['read'], prompt: 'p' }
          ]
        }),
        'utf-8'
      )
      expect(listCustomPresetView().presets.map(e => e.preset.id)).toEqual([
        'subagent',
        'subagent-2'
      ])
    })

    it('legacy 目录文件在无文档时同样经迁移入口进入视图', () => {
      const legacyDir = join(state.novaHome, 'subagents')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(
        join(legacyDir, 'solo.json'),
        JSON.stringify({ name: 'solo', description: 's', allowedTools: ['read'], prompt: 'p' }),
        'utf-8'
      )
      expect(existsSync(globalFile())).toBe(false)
      const view = listCustomPresetView()
      expect(view.presets[0]?.preset.id).toBe('solo')
      // 读取不产生写盘副作用；旧目录保持原样
      expect(existsSync(globalFile())).toBe(false)
    })
  })

  describe('fail closed 诊断', () => {
    it('未知版本整层 fail closed 并给出诊断', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({ version: 99, revision: 0, presets: [] }),
        'utf-8'
      )
      const view = listCustomPresetView()
      expect(view.presets).toHaveLength(0)
      expect(view.diagnostics).toMatchObject([
        { code: 'unknown_version', location: 'global' }
      ])
    })

    it('部分字段非法只丢弃该条目并给出 invalid_preset 诊断', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({
          version: 2,
          revision: 1,
          presets: [
            preset(),
            { ...preset({ id: 'broken' }), maxToolRounds: -5 }
          ]
        }),
        'utf-8'
      )
      const view = listCustomPresetView()
      expect(view.presets.map(e => e.preset.id)).toEqual(['alpha'])
      expect(view.diagnostics).toMatchObject([
        { code: 'invalid_preset', location: 'global', presetId: 'broken', field: 'maxToolRounds' }
      ])
    })

    it('同层重复 ID 保留首个并诊断重复项', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({
          version: 2,
          revision: 1,
          presets: [preset(), preset({ description: 'second copy' })]
        }),
        'utf-8'
      )
      const view = listCustomPresetView()
      expect(view.presets).toHaveLength(1)
      expect(view.presets[0].preset.description).toBe('first')
      expect(view.diagnostics).toMatchObject([
        { code: 'duplicate_id', location: 'global', presetId: 'alpha' }
      ])
    })

    it('占用内置 ID 的条目被拒绝', () => {
      writeFileSync(
        globalFile(),
        JSON.stringify({
          version: 2,
          revision: 1,
          presets: [preset({ id: 'explore' })]
        }),
        'utf-8'
      )
      const view = listCustomPresetView()
      expect(view.presets).toHaveLength(0)
      expect(view.diagnostics[0]?.code).toBe('invalid_preset')
    })

    it('未知版本层级上 create 被拒绝，原文件不被覆盖清空', () => {
      const original = JSON.stringify({ version: 99, revision: 4, presets: [] })
      writeFileSync(globalFile(), original, 'utf-8')
      try {
        createPreset(preset(), 'global')
        expect.unreachable()
      } catch (error) {
        expect((error as SubagentPresetCommandError).code).toBe('corrupt_document')
      }
      expect(readFileSync(globalFile(), 'utf-8')).toBe(original)
    })

    it('非法 location 在存储入口被拒绝', () => {
      expect(() => createPreset(preset(), 'other' as 'global')).toThrow(/必须显式携带/)
    })
  })

  describe('location 语义与覆盖', () => {
    it('合并只按稳定 ID：project 覆盖 global，删除 project 后 global 恢复', () => {
      createPreset(preset(), 'global')
      createPreset(preset({ name: '项目版' }), 'project', workspace)
      const merged = loadMergedCustomPresets(workspace)
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ location: 'project', preset: { name: '项目版' } })

      deletePreset('alpha', 'project', workspace)
      const restored = loadMergedCustomPresets(workspace)
      expect(restored[0]).toMatchObject({ location: 'global', preset: { name: 'Alpha' } })
    })

    it('删除只作用于目标层级', () => {
      createPreset(preset(), 'global')
      createPreset(preset({ name: '项目版' }), 'project', workspace)
      deletePreset('alpha', 'global')
      const projectOnly = loadMergedCustomPresets(workspace)
      expect(projectOnly).toHaveLength(1)
      expect(projectOnly[0].location).toBe('project')
    })

    it('启停与删除写入目标层级文件', () => {
      createPreset(preset(), 'project', workspace)
      setPresetEnabled('alpha', false, 'project', workspace)
      const doc = JSON.parse(
        readFileSync(join(workspace, '.nova', 'subagents.json'), 'utf-8')
      )
      expect(doc.presets[0].enabled).toBe(false)
      deletePreset('alpha', 'project', workspace)
      expect(loadMergedCustomPresets(workspace)).toHaveLength(0)
    })
  })

  describe('派遣视图门控', () => {
    it('禁用项不出现在派遣视图与 ID 解析中，设置视图仍可见', () => {
      createPreset(preset(), 'global')
      setPresetEnabled('alpha', false, 'global')
      expect(listCustomPresets()).toHaveLength(0)
      expect(getSubAgentSpecFromStore('alpha')).toBeUndefined()
      expect(listCustomPresetView().presets).toHaveLength(1)
    })

    it('update 按稳定 ID 定位；未知 ID、ID 漂移与 builtin 保护返回类型化错误', () => {
      createPreset(preset(), 'global')
      expect(updatePreset('alpha', preset({ name: '新名' }), 'global').name).toBe('新名')
      expect(() =>
        updatePreset('missing', preset({ id: 'missing' }), 'global')
      ).toThrow(/不存在/)
      expect(() =>
        updatePreset('alpha', preset({ id: 'ghost' }), 'global')
      ).toThrow(/不可修改/)
      try {
        setPresetEnabled('explore', false, 'global')
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(SubagentPresetCommandError)
        expect((error as SubagentPresetCommandError).code).toBe('builtin_readonly')
      }
    })
  })
})
