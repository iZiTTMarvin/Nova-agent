import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getNovaHomeDir } from '../settings/novaSettings'
import { atomicWriteFileSync } from '../storage/atomicFile'
import type { SubAgentSpec } from '../../shared/settings/types'

interface PresetDocument {
  version: 1
  revision: number
  presets: SubAgentSpec[]
}

const DOC_VERSION = 1 as const

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

function isValidSpec(raw: unknown): raw is SubAgentSpec {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as SubAgentSpec).name === 'string' &&
    Boolean((raw as SubAgentSpec).name.trim()) &&
    typeof (raw as SubAgentSpec).description === 'string' &&
    typeof (raw as SubAgentSpec).prompt === 'string' &&
    Array.isArray((raw as SubAgentSpec).allowedTools)
  )
}

function scanLegacyDir(dir: string): SubAgentSpec[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SubAgentSpec
          return isValidSpec(parsed) ? parsed : null
        } catch {
          return null
        }
      })
      .filter((s): s is SubAgentSpec => s !== null)
  } catch {
    return []
  }
}

function readDocument(filePath: string): PresetDocument | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as PresetDocument
    if (raw.version !== DOC_VERSION || !Array.isArray(raw.presets)) return null
    const presets = raw.presets.filter(isValidSpec)
    return { version: DOC_VERSION, revision: Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0, presets }
  } catch {
    return null
  }
}

function writeDocument(filePath: string, doc: PresetDocument): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8')
}

function loadPresetsWithMigration(docPath: string, legacyDir: string): SubAgentSpec[] {
  const doc = readDocument(docPath)
  if (doc) return doc.presets
  const legacy = scanLegacyDir(legacyDir)
  if (legacy.length > 0) {
    const migrated: PresetDocument = { version: DOC_VERSION, revision: 1, presets: legacy }
    try {
      writeDocument(docPath, migrated)
    } catch {
      // migration write best-effort
    }
  }
  return legacy
}

export function loadGlobalPresets(): SubAgentSpec[] {
  return loadPresetsWithMigration(globalPresetFile(), globalLegacyDir())
}

export function loadProjectPresets(workspaceRoot: string): SubAgentSpec[] {
  return loadPresetsWithMigration(projectPresetFile(workspaceRoot), projectLegacyDir(workspaceRoot))
}

export function loadMergedCustomPresets(workspaceRoot?: string | null): Array<{ spec: SubAgentSpec; origin: 'global' | 'project' }> {
  const byName = new Map<string, { spec: SubAgentSpec; origin: 'global' | 'project' }>()
  for (const spec of loadGlobalPresets()) {
    byName.set(spec.name, { spec, origin: 'global' })
  }
  if (workspaceRoot) {
    for (const spec of loadProjectPresets(workspaceRoot)) {
      byName.set(spec.name, { spec, origin: 'project' })
    }
  }
  return [...byName.values()]
}

export function getPresetFilePaths(): { globalFile: string; projectFile: (workspaceRoot: string) => string } {
  return { globalFile: globalPresetFile(), projectFile: projectPresetFile }
}

export function savePreset(spec: SubAgentSpec, location: 'global' | 'project', workspaceRoot?: string | null): void {
  const filePath =
    location === 'project'
      ? workspaceRoot
        ? projectPresetFile(workspaceRoot)
        : null
      : globalPresetFile()
  if (!filePath) throw new Error('保存项目级子代理需要先打开工作区')
  let doc = readDocument(filePath)
  if (!doc) {
    const legacy = scanLegacyDir(location === 'project' ? projectLegacyDir(workspaceRoot!) : globalLegacyDir())
    const presets = legacy.filter(s => s.name !== spec.name)
    doc = { version: DOC_VERSION, revision: legacy.length > 0 ? 1 : 0, presets }
  }
  const idx = doc.presets.findIndex(s => s.name === spec.name)
  if (idx >= 0) doc.presets[idx] = spec
  else doc.presets.push(spec)
  doc.revision += 1
  writeDocument(filePath, doc)
  const legacyDir = location === 'project' ? projectLegacyDir(workspaceRoot!) : globalLegacyDir()
  if (existsSync(legacyDir)) {
    const legacyFile = join(legacyDir, `${spec.name}.json`)
    if (existsSync(legacyFile)) {
      try {
        rmSync(legacyFile)
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function deletePreset(name: string, workspaceRoot?: string | null): boolean {
  let deleted = false
  const tryDelete = (filePath: string, legacyDir: string) => {
    const doc = readDocument(filePath)
    if (doc) {
      const before = doc.presets.length
      doc.presets = doc.presets.filter(s => s.name !== name)
      if (doc.presets.length !== before) {
        doc.revision += 1
        writeDocument(filePath, doc)
        deleted = true
      }
    }
    const legacyFile = join(legacyDir, `${name}.json`)
    if (existsSync(legacyFile)) {
      try {
        rmSync(legacyFile)
        deleted = true
      } catch {
        // ignore
      }
    }
  }
  tryDelete(globalPresetFile(), globalLegacyDir())
  if (workspaceRoot) tryDelete(projectPresetFile(workspaceRoot), projectLegacyDir(workspaceRoot))
  return deleted
}

export function getSubAgentSpecFromStore(name: string, workspaceRoot?: string | null): SubAgentSpec | undefined {
  const merged = loadMergedCustomPresets(workspaceRoot)
  const found = merged.find(e => e.spec.name === name)
  return found?.spec
}

export function listCustomPresets(workspaceRoot?: string | null): SubAgentSpec[] {
  return loadMergedCustomPresets(workspaceRoot).map(e => e.spec)
}
