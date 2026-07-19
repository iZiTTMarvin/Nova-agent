/**
 * 基于 TypeScript 编译器 API 的 import 扫描与路径解析。
 * 仅作为开发门禁，不进入产品运行时。
 */

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  buildViolationsForEdge,
  toRepoPosixPath,
  type BoundaryViolation,
  type UnscannableImport
} from './importBoundaryRules'

const ALIAS_TO_SRC_PREFIX: ReadonlyArray<{ prefix: string; target: string }> = [
  { prefix: '@shared/', target: 'src/shared/' },
  { prefix: '@runtime/', target: 'src/runtime/' },
  { prefix: '@main/', target: 'src/main/' },
  { prefix: '@preload/', target: 'src/preload/' },
  { prefix: '@renderer/', target: 'src/renderer/' }
]

const RESOLVE_EXTENSIONS = ['.ts', '.tsx'] as const

/** 外部资源包不参与层级判定；仓库内资源仍按真实路径检查依赖方向。 */
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wasm',
  '.json',
  '.md',
  '.txt'
])

export type ModuleSpecifierKind =
  | 'import'
  | 'export-from'
  | 'dynamic-import'
  | 'import-type'
  | 'require'

export type ExtractedSpecifier = {
  specifier: string
  kind: ModuleSpecifierKind
}

export type ExtractImportsResult = {
  specifiers: ExtractedSpecifier[]
  unscannable: Array<{ kind: 'dynamic-import' | 'require'; detail: string }>
}

export type FileExistsFn = (repoRelativePosix: string) => boolean

export type ResolveModuleResult =
  | { kind: 'external'; specifier: string }
  | { kind: 'asset'; specifier: string }
  | { kind: 'resolved'; path: string }
  | { kind: 'unresolved'; specifier: string; tried: string[] }

export type ScanSourceTreeResult = {
  violations: BoundaryViolation[]
  unscannable: UnscannableImport[]
  unresolved: Array<{ from: string; specifier: string; tried: string[] }>
  fileCount: number
}

/** 从源码文本提取所有可静态识别的模块说明符 */
export function extractModuleSpecifiers(sourceText: string, fileName = 'virtual.ts'): ExtractImportsResult {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind
  )

  const specifiers: ExtractedSpecifier[] = []
  const unscannable: ExtractImportsResult['unscannable'] = []

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ specifier: node.moduleSpecifier.text, kind: 'import' })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({ specifier: node.moduleSpecifier.text, kind: 'export-from' })
    } else if (ts.isImportTypeNode(node)) {
      const literal = getImportTypeLiteral(node)
      if (literal) {
        specifiers.push({ specifier: literal, kind: 'import-type' })
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) {
          specifiers.push({ specifier: arg.text, kind: 'dynamic-import' })
        } else if (arg) {
          unscannable.push({
            kind: 'dynamic-import',
            detail: `non-literal dynamic import at pos ${arg.pos}`
          })
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) {
          specifiers.push({ specifier: arg.text, kind: 'require' })
        } else if (arg) {
          unscannable.push({
            kind: 'require',
            detail: `non-literal require at pos ${arg.pos}`
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { specifiers, unscannable }
}

function getImportTypeLiteral(node: ts.ImportTypeNode): string | null {
  if (!ts.isLiteralTypeNode(node.argument)) return null
  if (!ts.isStringLiteralLike(node.argument.literal)) return null
  return node.argument.literal.text
}

export function normalizeSpecifier(specifier: string): string {
  return specifier.replace(/\\/g, '/')
}

export function isAssetSpecifier(specifier: string): boolean {
  const normalized = normalizeSpecifier(specifier)
  const base = normalized.split('/').pop() ?? normalized
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return ASSET_EXTENSIONS.has(base.slice(dot).toLowerCase())
}

export function isInternalModuleSpecifier(specifier: string): boolean {
  const normalized = normalizeSpecifier(specifier)
  if (normalized.startsWith('./') || normalized.startsWith('../')) return true
  return ALIAS_TO_SRC_PREFIX.some(({ prefix }) => normalized.startsWith(prefix))
}

/**
 * 解析相对路径与路径别名；第三方包与 Node builtin 视为 external。
 * 外部样式/图片等资源视为 asset；仓库内资源必须解析到真实路径并参与层级判定。
 * 内部模块无法落到真实文件（TS 含目录 index）时返回 unresolved。
 */
export function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
  exists: FileExistsFn
): ResolveModuleResult {
  const from = toRepoPosixPath(fromFile)
  const normalizedSpecifier = normalizeSpecifier(specifier)

  const internal = isInternalModuleSpecifier(normalizedSpecifier)
  if (isAssetSpecifier(normalizedSpecifier) && !internal) {
    return { kind: 'asset', specifier: normalizedSpecifier }
  }

  if (!internal) {
    return { kind: 'external', specifier: normalizedSpecifier }
  }

  let basePath: string
  if (normalizedSpecifier.startsWith('./') || normalizedSpecifier.startsWith('../')) {
    const fromDir = path.posix.dirname(from)
    basePath = toRepoPosixPath(path.posix.normalize(path.posix.join(fromDir, normalizedSpecifier)))
  } else {
    const alias = ALIAS_TO_SRC_PREFIX.find(({ prefix }) => normalizedSpecifier.startsWith(prefix))
    if (!alias) {
      return { kind: 'external', specifier: normalizedSpecifier }
    }
    basePath = toRepoPosixPath(alias.target + normalizedSpecifier.slice(alias.prefix.length))
  }

  if (isAssetSpecifier(normalizedSpecifier)) {
    return exists(basePath)
      ? { kind: 'resolved', path: basePath }
      : { kind: 'unresolved', specifier: normalizedSpecifier, tried: [basePath] }
  }

  const tried: string[] = []
  const candidates = buildResolveCandidates(basePath)
  for (const candidate of candidates) {
    tried.push(candidate)
    if (exists(candidate)) {
      return { kind: 'resolved', path: candidate }
    }
  }

  return { kind: 'unresolved', specifier: normalizedSpecifier, tried }
}

function buildResolveCandidates(basePath: string): string[] {
  const normalized = toRepoPosixPath(basePath)
  const candidates: string[] = []

  const hasKnownExt = RESOLVE_EXTENSIONS.some((ext) => normalized.endsWith(ext))
  if (hasKnownExt) {
    candidates.push(normalized)
    return candidates
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(`${normalized}${ext}`)
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    candidates.push(`${normalized}/index${ext}`)
  }
  return candidates
}

export function collectViolationsFromSource(params: {
  fromFile: string
  sourceText: string
  exists: FileExistsFn
}): {
  violations: BoundaryViolation[]
  unscannable: UnscannableImport[]
  unresolved: Array<{ from: string; specifier: string; tried: string[] }>
} {
  const from = toRepoPosixPath(params.fromFile)
  const extracted = extractModuleSpecifiers(params.sourceText, from)
  const violations: BoundaryViolation[] = []
  const unresolved: Array<{ from: string; specifier: string; tried: string[] }> = []
  const unscannable: UnscannableImport[] = extracted.unscannable.map((item) => ({
    from,
    kind: item.kind,
    detail: item.detail
  }))

  const seen = new Set<string>()
  for (const item of extracted.specifiers) {
    const resolved = resolveModuleSpecifier(from, item.specifier, params.exists)
    if (resolved.kind === 'external' || resolved.kind === 'asset') continue
    if (resolved.kind === 'unresolved') {
      unresolved.push({ from, specifier: item.specifier, tried: resolved.tried })
      continue
    }

    for (const violation of buildViolationsForEdge(from, resolved.path, item.specifier)) {
      const key = `${violation.from}\0${violation.to}\0${violation.rule}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push(violation)
    }
  }

  return { violations, unscannable, unresolved }
}

export function createFsExists(repoRoot: string): FileExistsFn {
  return (repoRelativePosix: string) => {
    const absolute = path.join(repoRoot, ...toRepoPosixPath(repoRelativePosix).split('/'))
    return fs.existsSync(absolute)
  }
}

export function listSrcTypeScriptFiles(repoRoot: string): string[] {
  const srcRoot = path.join(repoRoot, 'src')
  const files: string[] = []

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      if (entry.name.endsWith('.d.ts')) continue
      const relative = toRepoPosixPath(path.relative(repoRoot, absolute))
      files.push(relative)
    }
  }

  walk(srcRoot)
  return files.sort((a, b) => a.localeCompare(b))
}

/** 扫描仓库 src/ 下全部生产 TypeScript 源文件 */
export function scanSourceTree(repoRoot: string): ScanSourceTreeResult {
  const exists = createFsExists(repoRoot)
  const files = listSrcTypeScriptFiles(repoRoot)
  const violations: BoundaryViolation[] = []
  const unscannable: UnscannableImport[] = []
  const unresolved: Array<{ from: string; specifier: string; tried: string[] }> = []
  const seen = new Set<string>()

  for (const from of files) {
    const absolute = path.join(repoRoot, ...from.split('/'))
    const sourceText = fs.readFileSync(absolute, 'utf8')
    const result = collectViolationsFromSource({ fromFile: from, sourceText, exists })
    unscannable.push(...result.unscannable)
    unresolved.push(...result.unresolved)
    for (const violation of result.violations) {
      const key = `${violation.from}\0${violation.to}\0${violation.rule}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push(violation)
    }
  }

  violations.sort((a, b) =>
    `${a.from}->${a.to}->${a.rule}`.localeCompare(`${b.from}->${b.to}->${b.rule}`)
  )

  return {
    violations,
    unscannable,
    unresolved,
    fileCount: files.length
  }
}

export function findRepoRoot(fromDir = process.cwd()): string {
  let current = path.resolve(fromDir)
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'src'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`无法从 ${fromDir} 定位仓库根目录`)
    }
    current = parent
  }
}
