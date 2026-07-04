/**
 * 内置编排脚本注册表。
 * 脚本源文件在 builtin/；加载路径兼容 vitest（源码旁）与 electron-vite 打包（out/main/workflow/builtin）。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseMeta } from './meta'
import type { WorkflowMeta } from './types'

export interface BuiltinEntry {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  script: string
}

/** 解析内置脚本文件路径（测试态 / 打包态双候选） */
function resolveBuiltinFile(fileName: string): string | null {
  const candidates = [
    // vitest：本模块在 src/runtime/workflow/
    join(__dirname, 'builtin', fileName),
    // electron-vite 打包：__dirname = out/main/，资源由 copy 插件落到 workflow/builtin/
    join(__dirname, 'workflow', 'builtin', fileName)
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

function loadScriptFile(fileName: string): string {
  const path = resolveBuiltinFile(fileName)
  if (!path) {
    throw new Error(`built-in workflow script not found: ${fileName}`)
  }
  return readFileSync(path, 'utf-8')
}

const SCRIPT_FILES = ['smoke.js', 'br-full-dev.js'] as const

// null-prototype：避免 get("constructor") 命中 Object.prototype
const REGISTRY: Record<string, BuiltinEntry> = Object.create(null) as Record<string, BuiltinEntry>

function ensureLoaded(): void {
  if (Object.keys(REGISTRY).length > 0) return
  for (const file of SCRIPT_FILES) {
    const script = loadScriptFile(file)
    const parsed = parseMeta(script)
    if (!parsed.ok) {
      throw new Error(`built-in workflow ${file} failed to parse meta: ${parsed.error}`)
    }
    const meta: WorkflowMeta = parsed.meta
    REGISTRY[meta.name] = {
      name: meta.name,
      description: meta.description,
      whenToUse: meta.whenToUse,
      phases: meta.phases,
      script
    }
  }
}

export function listBuiltinScripts(): BuiltinEntry[] {
  ensureLoaded()
  return Object.values(REGISTRY).sort((a, b) => a.name.localeCompare(b.name))
}

export function getBuiltinScript(name: string): BuiltinEntry | undefined {
  ensureLoaded()
  return REGISTRY[name]
}

/** 测试辅助：清空缓存以便重载 */
export function _resetBuiltinRegistryForTests(): void {
  for (const key of Object.keys(REGISTRY)) {
    delete REGISTRY[key]
  }
}
