import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { getNovaHomeDir } from '../settings/novaSettings'
import { atomicWriteFileSync } from '../storage/atomicFile'
import type {
  SubAgentSpec,
  SubagentPresetDiagnostic,
  SubagentPresetLocation
} from '../../shared/settings/types'
import {
  decodeDocumentRevision,
  decodePresetDocument,
  decodeSubagentPreset,
  encodePresetDocument,
  migrateLegacyPresets,
  SubagentPresetDecodeError
} from './presetCodec'
import { isBuiltinSubagentId } from '../../shared/subagents/presetIdentity'

export type SubagentPresetCommandErrorCode =
  | 'builtin_readonly'
  | 'corrupt_document'
  | 'duplicate_id'
  | 'invalid_location'
  | 'invalid_preset'
  | 'not_found'
  | 'project_without_workspace'

export class SubagentPresetCommandError extends Error {
  readonly name = 'SubagentPresetCommandError'
  constructor(
    readonly code: SubagentPresetCommandErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** 一条 preset 存储层的读取结果：presets 为真相子集，diagnostics 记录被拒绝内容。 */
interface PresetLayer {
  filePath: string
  revision: number
  presets: SubAgentSpec[]
  diagnostics: SubagentPresetDiagnostic[]
}

export interface SubagentPresetViewEntry {
  preset: SubAgentSpec
  location: SubagentPresetLocation
  filePath: string
}

function globalPresetFile(): string {
  return join(getNovaHomeDir(), 'subagents.json')
}

function projectPresetFile(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'subagents.json')
}

function globalLegacyDir(): string {
  return join(getNovaHomeDir(), 'subagents')
}

function projectLegacyDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.nova', 'subagents')
}

function layerFiles(location: SubagentPresetLocation, workspaceRoot?: string | null): {
  filePath: string
  legacyDir: string
} {
  if (location !== 'global' && location !== 'project') {
    throw new SubagentPresetCommandError(
      'invalid_location',
      '子代理命令必须显式携带 global 或 project 层级'
    )
  }
  if (location === 'project') {
    if (!workspaceRoot) {
      throw new SubagentPresetCommandError(
        'project_without_workspace',
        '保存项目级子代理需要先打开工作区'
      )
    }
    return { filePath: projectPresetFile(workspaceRoot), legacyDir: projectLegacyDir(workspaceRoot) }
  }
  return { filePath: globalPresetFile(), legacyDir: globalLegacyDir() }
}

/** 某层级 preset 文件的权威路径；project 层级要求已打开工作区。 */
export function getPresetFilePath(
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): string {
  return layerFiles(location, workspaceRoot).filePath
}

/**
 * 唯一读取入口：文档缺失=真空；损坏/未知版本返回诊断而非空数组伪装。
 * 同层内文档优先于 legacy 目录；显式写入物化文档后旧目录整体失效。
 */
function readLayer(location: SubagentPresetLocation, workspaceRoot?: string | null): PresetLayer {
  const { filePath, legacyDir } = layerFiles(location, workspaceRoot)
  if (!existsSync(filePath)) {
    const legacy = readLegacyDir(legacyDir, location)
    return { filePath, revision: 0, presets: legacy.presets, diagnostics: legacy.diagnostics }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return {
      filePath,
      revision: 0,
      presets: [],
      diagnostics: [
        {
          code: 'document_unreadable',
          location,
          message: `子代理配置文件无法解析：${filePath}`
        }
      ]
    }
  }
  const decoded = decodePresetDocument(parsed, location)
  return {
    filePath,
    revision: decodeDocumentRevision(parsed),
    presets: decoded.presets,
    diagnostics: decoded.diagnostics
  }
}

function readLegacyDir(legacyDir: string, location: SubagentPresetLocation): {
  presets: SubAgentSpec[]
  diagnostics: SubagentPresetDiagnostic[]
} {
  if (!existsSync(legacyDir)) return { presets: [], diagnostics: [] }
  const items: unknown[] = []
  try {
    for (const entry of readdirSync(legacyDir)) {
      if (!entry.endsWith('.json')) continue
      try {
        items.push(JSON.parse(readFileSync(join(legacyDir, entry), 'utf-8')))
      } catch {
        // 单文件损坏：交由迁移入口统一给出 invalid_preset 诊断
        items.push(null)
      }
    }
  } catch {
    return {
      presets: [],
      diagnostics: [
        {
          code: 'document_unreadable',
          location,
          message: `旧版子代理目录无法读取：${legacyDir}`
        }
      ]
    }
  }
  return migrateLegacyPresets(items, location)
}

function writeLayer(layer: PresetLayer, presets: readonly SubAgentSpec[]): void {
  const dir = join(layer.filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(layer.filePath, encodePresetDocument(presets, layer.revision + 1), 'utf8')
}

/** global 与 project 同 ID 表示显式覆盖；合并只按稳定 ID，不按显示名。 */
export function loadMergedCustomPresets(
  workspaceRoot?: string | null
): Array<{ preset: SubAgentSpec; location: SubagentPresetLocation; filePath: string }> {
  const globalLayer = readLayer('global')
  const merged = new Map<string, { preset: SubAgentSpec; location: SubagentPresetLocation; filePath: string }>()
  for (const preset of globalLayer.presets) {
    merged.set(preset.id, { preset, location: 'global', filePath: globalLayer.filePath })
  }
  if (workspaceRoot) {
    const projectLayer = readLayer('project', workspaceRoot)
    for (const preset of projectLayer.presets) {
      merged.set(preset.id, { preset, location: 'project', filePath: projectLayer.filePath })
    }
  }
  return [...merged.values()]
}

/** 设置视图：全部自定义 preset（含禁用）与本层诊断投影。 */
export function listCustomPresetView(
  workspaceRoot?: string | null
): { presets: SubagentPresetViewEntry[]; diagnostics: SubagentPresetDiagnostic[] } {
  const globalLayer = readLayer('global')
  const diagnostics = [...globalLayer.diagnostics]
  const merged = new Map<string, SubagentPresetViewEntry>()
  for (const preset of globalLayer.presets) {
    merged.set(preset.id, { preset, location: 'global', filePath: globalLayer.filePath })
  }
  if (workspaceRoot) {
    const projectLayer = readLayer('project', workspaceRoot)
    diagnostics.push(...projectLayer.diagnostics)
    for (const preset of projectLayer.presets) {
      merged.set(preset.id, { preset, location: 'project', filePath: projectLayer.filePath })
    }
  }
  return { presets: [...merged.values()], diagnostics }
}

/** 派遣视图：仅启用项；project 同 ID 覆盖 global。 */
export function listCustomPresets(workspaceRoot?: string | null): SubAgentSpec[] {
  return loadMergedCustomPresets(workspaceRoot)
    .filter((entry) => entry.preset.enabled)
    .map((entry) => entry.preset)
}

/** 按稳定 ID 解析可派遣 preset；禁用与未知 ID 同样 fail closed。 */
export function getSubAgentSpecFromStore(
  profileId: string,
  workspaceRoot?: string | null
): SubAgentSpec | undefined {
  return listCustomPresets(workspaceRoot).find((preset) => preset.id === profileId)
}

function decodeDraft(input: unknown): SubAgentSpec {
  try {
    return decodeSubagentPreset(input)
  } catch (error) {
    if (error instanceof SubagentPresetDecodeError) {
      throw new SubagentPresetCommandError('invalid_preset', error.message)
    }
    throw error
  }
}

/** 文档级诊断意味着该层内容不可安全合并，任何写入都必须先修复文档。 */
function requireWritableLayer(
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): PresetLayer {
  const layer = readLayer(location, workspaceRoot)
  if (
    layer.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === 'document_unreadable' || diagnostic.code === 'unknown_version'
    )
  ) {
    throw new SubagentPresetCommandError(
      'corrupt_document',
      `目标层级配置不可判定或已损坏，先修复后再写入：${layer.filePath}`
    )
  }
  return layer
}

/** 创建：目标层级重复 ID 拒绝而非静默更新；内置 ID 在领域边界拒绝。 */
export function createPreset(
  input: unknown,
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): SubAgentSpec {
  const preset = decodeDraft(input)
  const layer = requireWritableLayer(location, workspaceRoot)
  if (layer.presets.some((entry) => entry.id === preset.id)) {
    throw new SubagentPresetCommandError(
      'duplicate_id',
      `该层级已存在同 ID 子代理「${preset.id}」；如需修改请使用更新，或显式覆盖另一层级`
    )
  }
  writeLayer(layer, [...layer.presets, preset])
  return preset
}

/** 更新：按调用方显式给出的目标 ID 定位本层条目；ID 创建后不可改，显示名可改。 */
export function updatePreset(
  targetId: string,
  input: unknown,
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): SubAgentSpec {
  const preset = decodeDraft(input)
  if (preset.id !== targetId) {
    throw new SubagentPresetCommandError(
      'invalid_preset',
      `子代理 ID 创建后不可修改（expected=${targetId}, actual=${preset.id}）`
    )
  }
  const layer = requireWritableLayer(location, workspaceRoot)
  const index = layer.presets.findIndex((entry) => entry.id === targetId)
  if (index < 0) {
    throw new SubagentPresetCommandError(
      'not_found',
      `该层级不存在 ID「${targetId}」的子代理；创建请使用创建命令`
    )
  }
  const next = [...layer.presets]
  next[index] = preset
  writeLayer(layer, next)
  return preset
}

/** 启停：禁用只影响新派遣；历史 Child Session 按冻结配置恢复或重放。 */
export function setPresetEnabled(
  id: string,
  enabled: boolean,
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): SubAgentSpec {
  assertNotBuiltin(id)
  const layer = requireWritableLayer(location, workspaceRoot)
  const index = layer.presets.findIndex((entry) => entry.id === id)
  if (index < 0) {
    throw new SubagentPresetCommandError('not_found', `该层级不存在 ID「${id}」的子代理`)
  }
  const next = [...layer.presets]
  next[index] = { ...next[index], enabled }
  writeLayer(layer, next)
  return next[index]
}

/** 删除：只影响目标层级；删除 project 覆盖后同 ID 的 global 项自动恢复显示。 */
export function deletePreset(
  id: string,
  location: SubagentPresetLocation,
  workspaceRoot?: string | null
): void {
  assertNotBuiltin(id)
  const layer = requireWritableLayer(location, workspaceRoot)
  const remaining = layer.presets.filter((entry) => entry.id !== id)
  if (remaining.length === layer.presets.length) {
    throw new SubagentPresetCommandError('not_found', `该层级不存在 ID「${id}」的子代理`)
  }
  writeLayer(layer, remaining)
}

function assertNotBuiltin(id: string): void {
  if (isBuiltinSubagentId(id)) {
    throw new SubagentPresetCommandError('builtin_readonly', `内置子代理「${id}」不可写入或删除`)
  }
}
