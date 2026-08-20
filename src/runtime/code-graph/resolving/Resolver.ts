import type {
  CodeGraphFileEdgeInput,
  CodeGraphFileInput,
  CodeGraphGenerationInput,
  CodeGraphSymbolEdgeInput,
  CodeGraphSymbolInput,
  CodeGraphUnresolvedRelationInput
} from '../graph/CodeGraphRepository'
import type {
  ParsedCall,
  ParsedExport,
  ParsedImport,
  ParsedImportBinding,
  ParsedInheritance,
  ParsedReference,
  ParsedSourceFile,
  ParsedSymbol
} from '../parsing/ParserRegistry'
import type {
  CodeRelationResolver,
  CodeSymbolEdgeKind,
  CodeUnresolvedReason
} from '../types'
import {
  MODULE_PATH_RESOLVER_SIGNATURE,
  ModulePathResolver,
  type ModulePathResolution
} from './ModulePathResolver'
import {
  PYTHON_RESOLVER_SIGNATURE,
  PythonResolver
} from './PythonResolver'
import { WorkspaceModuleFileIndex } from './WorkspaceModuleFileIndex'

export const STRUCTURAL_RESOLVER_SIGNATURE =
  `${MODULE_PATH_RESOLVER_SIGNATURE};${PYTHON_RESOLVER_SIGNATURE};structural-binding-v1`

export interface CodeGraphResolveInput {
  readonly workspaceRoot: string
  readonly operationId: string
  readonly generation: number
  readonly parserSignature: string
  readonly stagedAt: number
  readonly parsedFiles: readonly ParsedSourceFile[]
  readonly additionalFiles?: readonly CodeGraphFileInput[]
  readonly configFiles: readonly string[]
  readonly mtimeMsByPath: ReadonlyMap<string, number>
}

export interface CodeGraphResolveControl {
  throwIfCancelled(): void
}

export interface CodeGraphResolver {
  readonly signature: string
  resolve(
    input: CodeGraphResolveInput,
    control?: CodeGraphResolveControl
  ): Promise<CodeGraphGenerationInput>
}

interface ResolvedImport {
  readonly parsed: ParsedImport
  readonly resolution: ModulePathResolution
}

interface ResolvedExportSymbol {
  readonly symbol: ParsedSymbol
  readonly resolver: CodeRelationResolver
}

type ExportResolution =
  | { readonly kind: 'resolved'; readonly value: ResolvedExportSymbol }
  | {
      readonly kind: 'unresolved'
      readonly reason: CodeUnresolvedReason
      readonly resolver: CodeRelationResolver
    }

/** 把结构候选收敛为可追溯边；任何歧义都保留为 unresolved。 */
export class StructuralCodeGraphResolver implements CodeGraphResolver {
  readonly signature = STRUCTURAL_RESOLVER_SIGNATURE

  async resolve(
    input: CodeGraphResolveInput,
    control?: CodeGraphResolveControl
  ): Promise<CodeGraphGenerationInput> {
    const checkpoint = createResolveCheckpoint(control)
    control?.throwIfCancelled()
    const parsedByPath = uniqueParsedFiles(input.parsedFiles)
    const graphFiles = buildGraphFiles(input, parsedByPath)
    const fileIndex = new WorkspaceModuleFileIndex(graphFiles.map((file) => file.path))
    const moduleResolver = await ModulePathResolver.create({
      workspaceRoot: input.workspaceRoot,
      fileIndex,
      configFiles: input.configFiles
    })
    const pythonResolver = new PythonResolver(fileIndex)
    const fileEdges: CodeGraphFileEdgeInput[] = []
    const symbolEdges: CodeGraphSymbolEdgeInput[] = []
    const unresolved: CodeGraphUnresolvedRelationInput[] = []
    const symbols: CodeGraphSymbolInput[] = []
    for (const file of parsedByPath.values()) {
      if (file.parseStatus !== 'parsed') continue
      for (const symbol of file.symbols) {
        control?.throwIfCancelled()
        symbols.push(toGraphSymbol(file.path, symbol))
      }
    }
    const resolvedImports = new Map<string, readonly ResolvedImport[]>()

    for (const file of parsedByPath.values()) {
      if (file.parseStatus !== 'parsed') {
        await checkpoint()
        continue
      }
      const imports: ResolvedImport[] = []
      for (const parsed of file.imports) {
        control?.throwIfCancelled()
        imports.push({
          parsed,
          resolution: resolveModulePath(
            moduleResolver,
            pythonResolver,
            file,
            parsed.moduleSpecifier
          )
        })
      }
      resolvedImports.set(file.path, Object.freeze(imports))
      for (const item of imports) {
        control?.throwIfCancelled()
        const edgeKind = item.parsed.kind === 're_export' ? 're_exports' : 'imports'
        if (item.resolution.kind === 'resolved') {
          fileEdges.push(Object.freeze({
            sourcePath: file.path,
            targetPath: item.resolution.path,
            kind: edgeKind,
            confidence: 'probable',
            resolver: item.resolution.resolver,
            sourceLine: item.parsed.sourceLine
          }))
        } else {
          unresolved.push(unresolvedRelation({
            filePath: file.path,
            sourceSymbolId: null,
            kind: edgeKind,
            rawTarget: item.parsed.moduleSpecifier,
            moduleSpecifier: item.parsed.moduleSpecifier,
            sourceLine: item.parsed.sourceLine,
            reason: item.resolution.reason,
            resolver: item.resolution.resolver
          }))
        }
      }
      await checkpoint()
    }

    const context: ResolveContext = {
      parsedByPath,
      moduleResolver,
      pythonResolver,
      resolvedImports,
      symbolEdges,
      unresolved
    }
    for (const file of parsedByPath.values()) {
      if (file.parseStatus !== 'parsed') {
        await checkpoint()
        continue
      }
      for (const call of file.calls) {
        control?.throwIfCancelled()
        resolveCall(context, file, call)
      }
      for (const reference of file.references) {
        control?.throwIfCancelled()
        resolveReference(context, file, reference)
      }
      for (const inheritance of file.inheritance) {
        control?.throwIfCancelled()
        resolveInheritance(context, file, inheritance)
      }
      await checkpoint()
    }
    fileEdges.push(...await buildTestEdges(graphFiles, fileEdges, checkpoint, control))
    await yieldResolveControl(control)

    return Object.freeze({
      operationId: input.operationId,
      generation: input.generation,
      parserSignature: input.parserSignature,
      resolverSignature: this.signature,
      stagedAt: input.stagedAt,
      files: Object.freeze(sortFiles(graphFiles)),
      symbols: Object.freeze(sortSymbols(symbols)),
      fileEdges: Object.freeze(dedupeAndSortFileEdges(fileEdges)),
      symbolEdges: Object.freeze(dedupeAndSortSymbolEdges(symbolEdges)),
      unresolvedRelations: Object.freeze(dedupeAndSortUnresolved(unresolved))
    })
  }
}

interface ResolveContext {
  readonly parsedByPath: ReadonlyMap<string, ParsedSourceFile>
  readonly moduleResolver: ModulePathResolver
  readonly pythonResolver: PythonResolver
  readonly resolvedImports: ReadonlyMap<string, readonly ResolvedImport[]>
  readonly symbolEdges: CodeGraphSymbolEdgeInput[]
  readonly unresolved: CodeGraphUnresolvedRelationInput[]
}

function resolveCall(
  context: ResolveContext,
  file: ParsedSourceFile,
  call: ParsedCall
): void {
  if (call.bindingName) {
    resolveImportedRelation(context, file, {
      sourceSymbolId: call.sourceSymbolId,
      rawTarget: call.rawTarget,
      bindingName: call.bindingName,
      kind: 'calls',
      sourceLine: call.sourceLine
    })
    return
  }
  const target = resolveSameFileTarget(file, call.sourceSymbolId, call.rawTarget)
  if (target.kind === 'resolved') {
    context.symbolEdges.push(symbolEdge(
      call.sourceSymbolId,
      target.symbol.stableId,
      'calls',
      'confirmed',
      'structural',
      file.path,
      call.sourceLine
    ))
  } else {
    context.unresolved.push(unresolvedRelation({
      filePath: file.path,
      sourceSymbolId: call.sourceSymbolId,
      kind: 'calls',
      rawTarget: call.rawTarget,
      moduleSpecifier: null,
      sourceLine: call.sourceLine,
      reason: target.reason,
      resolver: 'structural'
    }))
  }
}

function resolveReference(
  context: ResolveContext,
  file: ParsedSourceFile,
  reference: ParsedReference
): void {
  resolveImportedRelation(context, file, {
    sourceSymbolId: reference.sourceSymbolId,
    rawTarget: reference.rawTarget,
    bindingName: reference.localBinding,
    kind: 'references',
    sourceLine: reference.sourceLine
  })
}

function resolveInheritance(
  context: ResolveContext,
  file: ParsedSourceFile,
  inheritance: ParsedInheritance
): void {
  const bindingName = rootIdentifier(inheritance.rawTarget)
  const hasImport = importBindingsFor(context, file.path, bindingName).length > 0
  if (hasImport) {
    resolveImportedRelation(context, file, {
      sourceSymbolId: inheritance.sourceSymbolId,
      rawTarget: inheritance.rawTarget,
      bindingName,
      kind: inheritance.kind,
      sourceLine: inheritance.sourceLine
    })
    return
  }
  const target = resolveSameFileTarget(
    file,
    inheritance.sourceSymbolId,
    inheritance.rawTarget
  )
  if (target.kind === 'resolved') {
    context.symbolEdges.push(symbolEdge(
      inheritance.sourceSymbolId,
      target.symbol.stableId,
      inheritance.kind,
      'confirmed',
      'structural',
      file.path,
      inheritance.sourceLine
    ))
  } else {
    context.unresolved.push(unresolvedRelation({
      filePath: file.path,
      sourceSymbolId: inheritance.sourceSymbolId,
      kind: inheritance.kind,
      rawTarget: inheritance.rawTarget,
      moduleSpecifier: null,
      sourceLine: inheritance.sourceLine,
      reason: target.reason,
      resolver: 'structural'
    }))
  }
}

interface ImportedRelationCandidate {
  readonly sourceSymbolId: string
  readonly rawTarget: string
  readonly bindingName: string
  readonly kind: CodeSymbolEdgeKind
  readonly sourceLine: number
}

function resolveImportedRelation(
  context: ResolveContext,
  file: ParsedSourceFile,
  candidate: ImportedRelationCandidate
): void {
  // parser 没有词法作用域证据时宁可降级，不把同名绑定误连为跨文件边。
  if (file.symbols.some((symbol) =>
    symbol.kind !== 'module' && symbol.name === candidate.bindingName
  )) {
    context.unresolved.push(importedUnresolved(
      file.path,
      candidate,
      null,
      'shadowed_import_binding',
      'structural'
    ))
    return
  }

  const bindings = importBindingsFor(context, file.path, candidate.bindingName)
  if (bindings.length !== 1) {
    context.unresolved.push(importedUnresolved(
      file.path,
      candidate,
      null,
      'ambiguous_export',
      'structural'
    ))
    return
  }
  const [{ resolvedImport, binding }] = bindings
  if (resolvedImport.resolution.kind !== 'resolved') {
    context.unresolved.push(importedUnresolved(
      file.path,
      candidate,
      resolvedImport.parsed.moduleSpecifier,
      resolvedImport.resolution.reason,
      resolvedImport.resolution.resolver
    ))
    return
  }

  const exportedName = binding.importedName ?? memberName(candidate.rawTarget)
  if (!exportedName) {
    context.unresolved.push(importedUnresolved(
      file.path,
      candidate,
      resolvedImport.parsed.moduleSpecifier,
      'export_not_found',
      resolvedImport.resolution.resolver
    ))
    return
  }
  const target = resolveExportedSymbol(
    context,
    resolvedImport.resolution.path,
    exportedName,
    0
  )
  if (target.kind === 'unresolved') {
    context.unresolved.push(importedUnresolved(
      file.path,
      candidate,
      resolvedImport.parsed.moduleSpecifier,
      target.reason,
      target.resolver
    ))
    return
  }
  context.symbolEdges.push(symbolEdge(
    candidate.sourceSymbolId,
    target.value.symbol.stableId,
    candidate.kind,
    'probable',
    target.value.resolver === 'index-re-export'
      ? 'index-re-export'
      : resolvedImport.resolution.resolver,
    file.path,
    candidate.sourceLine
  ))
}

function resolveExportedSymbol(
  context: ResolveContext,
  filePath: string,
  exportedName: string,
  depth: number
): ExportResolution {
  const file = context.parsedByPath.get(filePath)
  if (!file || file.parseStatus !== 'parsed') {
    return { kind: 'unresolved', reason: 'export_not_found', resolver: 'structural' }
  }
  const direct = directExportedSymbols(file, exportedName)
  const directSymbol = direct[0]
  if (direct.length === 1 && directSymbol) {
    return {
      kind: 'resolved',
      value: { symbol: directSymbol, resolver: 'structural' }
    }
  }
  if (direct.length > 1) {
    return { kind: 'unresolved', reason: 'ambiguous_export', resolver: 'structural' }
  }

  const reExports = file.exports.filter((item) =>
    item.moduleSpecifier !== null &&
    (item.exportedName === exportedName || item.wildcard)
  )
  if (reExports.length > 1) {
    return { kind: 'unresolved', reason: 'ambiguous_export', resolver: 'index-re-export' }
  }
  const reExport = reExports[0]
  if (!reExport) {
    return { kind: 'unresolved', reason: 'export_not_found', resolver: 'structural' }
  }
  if (depth >= 1) {
    return {
      kind: 'unresolved',
      reason: 'reexport_depth_exceeded',
      resolver: 'index-re-export'
    }
  }
  const moduleSpecifier = reExport.moduleSpecifier
  if (!moduleSpecifier) {
    return { kind: 'unresolved', reason: 'export_not_found', resolver: 'index-re-export' }
  }
  const resolution = resolveModulePath(
    context.moduleResolver,
    context.pythonResolver,
    file,
    moduleSpecifier
  )
  if (resolution.kind !== 'resolved') {
    return {
      kind: 'unresolved',
      reason: resolution.reason,
      resolver: resolution.resolver
    }
  }
  const nextName = reExport.wildcard
    ? exportedName
    : reExport.importedName ?? exportedName
  const nested = resolveExportedSymbol(context, resolution.path, nextName, depth + 1)
  return nested.kind === 'resolved'
    ? { kind: 'resolved', value: { ...nested.value, resolver: 'index-re-export' } }
    : nested
}

function directExportedSymbols(
  file: ParsedSourceFile,
  exportedName: string
): ParsedSymbol[] {
  const localNames = file.exports
    .filter((item) => item.moduleSpecifier === null && item.exportedName === exportedName)
    .map((item) => item.localName)
    .filter((name): name is string => name !== null)
  const candidates = file.symbols.filter((symbol) =>
    localNames.includes(symbol.name) ||
    (localNames.length === 0 && symbol.exported && symbol.name === exportedName)
  )
  return dedupeBy(candidates, (symbol) => symbol.stableId)
}

function importBindingsFor(
  context: ResolveContext,
  filePath: string,
  localName: string
): Array<{ readonly resolvedImport: ResolvedImport; readonly binding: ParsedImportBinding }> {
  const matches: Array<{
    readonly resolvedImport: ResolvedImport
    readonly binding: ParsedImportBinding
  }> = []
  for (const resolvedImport of context.resolvedImports.get(filePath) ?? []) {
    if (resolvedImport.parsed.kind !== 'import') continue
    for (const binding of resolvedImport.parsed.bindings) {
      if (binding.localName === localName) matches.push({ resolvedImport, binding })
    }
  }
  return matches
}

function resolveSameFileTarget(
  file: ParsedSourceFile,
  sourceSymbolId: string,
  rawTarget: string
):
  | { readonly kind: 'resolved'; readonly symbol: ParsedSymbol }
  | { readonly kind: 'unresolved'; readonly reason: Extract<
      CodeUnresolvedReason,
      'dynamic_dispatch' | 'same_file_target_ambiguous'
    > } {
  const member = rawTarget.match(/^(?:this|self)\.([A-Za-z_$][\w$]*)$/)?.[1]
  let candidates: ParsedSymbol[]
  if (member) {
    const source = file.symbols.find((symbol) => symbol.stableId === sourceSymbolId)
    const owner = source?.qualifiedName.includes('.')
      ? source.qualifiedName.slice(0, source.qualifiedName.lastIndexOf('.'))
      : null
    candidates = owner
      ? file.symbols.filter((symbol) =>
          symbol.name === member && symbol.qualifiedName === `${owner}.${member}`
        )
      : []
  } else if (/^[A-Za-z_$][\w$]*$/.test(rawTarget)) {
    candidates = file.symbols.filter((symbol) =>
      symbol.kind !== 'module' && symbol.name === rawTarget
    )
  } else {
    return { kind: 'unresolved', reason: 'dynamic_dispatch' }
  }
  const candidate = candidates[0]
  return candidates.length === 1 && candidate
    ? { kind: 'resolved', symbol: candidate }
    : { kind: 'unresolved', reason: 'same_file_target_ambiguous' }
}

function buildGraphFiles(
  input: CodeGraphResolveInput,
  parsedByPath: ReadonlyMap<string, ParsedSourceFile>
): CodeGraphFileInput[] {
  const files = [...(input.additionalFiles ?? [])]
  const paths = new Set(files.map((file) => file.path))
  for (const parsed of parsedByPath.values()) {
    if (paths.has(parsed.path)) throw new Error(`重复 graph file：${parsed.path}`)
    const mtimeMs = input.mtimeMsByPath.get(parsed.path)
    if (mtimeMs === undefined) throw new Error(`缺少文件 mtime：${parsed.path}`)
    paths.add(parsed.path)
    files.push(Object.freeze({
      path: parsed.path,
      language: parsed.language,
      contentHash: parsed.contentHash,
      sizeBytes: parsed.sizeBytes,
      mtimeMs,
      lineCount: parsed.lineCount,
      parseStatus: parsed.parseStatus
    }))
  }
  return files
}

function toGraphSymbol(filePath: string, symbol: ParsedSymbol): CodeGraphSymbolInput {
  return Object.freeze({
    stableId: symbol.stableId,
    filePath,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    exported: symbol.exported,
    signature: symbol.signature,
    docExcerpt: symbol.docExcerpt,
    identifierTokens: identifierTokens(symbol.name),
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    startByte: symbol.startByte,
    endByte: symbol.endByte
  })
}

async function buildTestEdges(
  files: readonly CodeGraphFileInput[],
  resolvedFileEdges: readonly CodeGraphFileEdgeInput[],
  checkpoint: () => Promise<void>,
  control: CodeGraphResolveControl | undefined
): Promise<CodeGraphFileEdgeInput[]> {
  const paths = new Set(files.map((file) => file.path))
  const edges: CodeGraphFileEdgeInput[] = []
  for (const file of files) {
    const linkedTargets = new Set<string>()
    const candidate = conventionTestTarget(file.path)
    if (candidate && paths.has(candidate)) {
      edges.push(testEdge(file.path, candidate, 1))
      linkedTargets.add(candidate)
    }
    if (isTestPath(file.path)) {
      for (const imported of resolvedFileEdges) {
        control?.throwIfCancelled()
        if (imported.kind !== 'imports' || imported.sourcePath !== file.path) continue
        if (linkedTargets.has(imported.targetPath)) continue
        edges.push(testEdge(file.path, imported.targetPath, imported.sourceLine))
        linkedTargets.add(imported.targetPath)
      }
    }
    await checkpoint()
  }
  return edges
}

const RESOLVE_BATCH_SIZE = 32

function createResolveCheckpoint(
  control: CodeGraphResolveControl | undefined
): () => Promise<void> {
  let completed = 0
  return async () => {
    control?.throwIfCancelled()
    completed += 1
    if (completed % RESOLVE_BATCH_SIZE !== 0) return
    // 每批让出 Worker 事件循环，同时重查共享取消标志。
    await yieldResolveControl(control)
  }
}

async function yieldResolveControl(
  control: CodeGraphResolveControl | undefined
): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  control?.throwIfCancelled()
}

function conventionTestTarget(filePath: string): string | null {
  const javascript = filePath.match(/^(.*)\.(?:test|spec)(\.[^.]+)$/)
  if (javascript?.[1] && javascript[2]) return `${javascript[1]}${javascript[2]}`

  const directory = pathDirectory(filePath)
  const basename = pathBasename(filePath)
  const pythonPrefix = basename.match(/^test_(.+)\.py$/)?.[1]
  if (pythonPrefix) return directory ? `${directory}/${pythonPrefix}.py` : `${pythonPrefix}.py`
  const pythonSuffix = basename.match(/^(.+)_test\.py$/)?.[1]
  if (pythonSuffix) return directory ? `${directory}/${pythonSuffix}.py` : `${pythonSuffix}.py`
  return null
}

function isTestPath(filePath: string): boolean {
  return /(?:^|\/)(?:__tests__|tests)(?:\/|$)/.test(filePath) ||
    /\.(?:test|spec)\.[^.]+$/.test(filePath) ||
    /(?:^|\/)(?:test_.+|.+_test)\.py$/.test(filePath)
}

function testEdge(
  sourcePath: string,
  targetPath: string,
  sourceLine: number
): CodeGraphFileEdgeInput {
  return Object.freeze({
    sourcePath,
    targetPath,
    kind: 'test_of',
    confidence: 'probable',
    resolver: 'test-convention',
    sourceLine
  })
}

function pathDirectory(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : ''
}

function pathBasename(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

function symbolEdge(
  sourceSymbolId: string,
  targetSymbolId: string,
  kind: CodeSymbolEdgeKind,
  confidence: CodeGraphSymbolEdgeInput['confidence'],
  resolver: CodeRelationResolver,
  sourceFile: string,
  sourceLine: number
): CodeGraphSymbolEdgeInput {
  return Object.freeze({
    sourceSymbolId,
    targetSymbolId,
    kind,
    confidence,
    resolver,
    sourceFile,
    sourceLine
  })
}

function unresolvedRelation(
  input: CodeGraphUnresolvedRelationInput
): CodeGraphUnresolvedRelationInput {
  return Object.freeze(input)
}

function importedUnresolved(
  filePath: string,
  candidate: ImportedRelationCandidate,
  moduleSpecifier: string | null,
  reason: CodeUnresolvedReason,
  resolver: CodeRelationResolver
): CodeGraphUnresolvedRelationInput {
  return unresolvedRelation({
    filePath,
    sourceSymbolId: candidate.sourceSymbolId,
    kind: candidate.kind,
    rawTarget: candidate.rawTarget,
    moduleSpecifier,
    sourceLine: candidate.sourceLine,
    reason,
    resolver
  })
}

function resolveModulePath(
  moduleResolver: ModulePathResolver,
  pythonResolver: PythonResolver,
  file: ParsedSourceFile,
  moduleSpecifier: string
): ModulePathResolution {
  return file.language === 'python'
    ? pythonResolver.resolve(file.path, moduleSpecifier)
    : moduleResolver.resolve(file.path, moduleSpecifier)
}

function memberName(rawTarget: string): string | null {
  const segments = rawTarget.split('.')
  return segments.length === 2 && segments[1] ? segments[1] : null
}

function rootIdentifier(rawTarget: string): string {
  return rawTarget.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? rawTarget
}

function identifierTokens(identifier: string): string {
  const separated = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .toLowerCase()
  const compact = identifier.replace(/[_\-\s]+/g, '').toLowerCase()
  return [...new Set([...separated.split(' ').filter(Boolean), compact])].join(' ')
}

function uniqueParsedFiles(
  parsedFiles: readonly ParsedSourceFile[]
): ReadonlyMap<string, ParsedSourceFile> {
  const files = new Map<string, ParsedSourceFile>()
  for (const file of parsedFiles) {
    if (files.has(file.path)) throw new Error(`重复 parsed file：${file.path}`)
    files.set(file.path, file)
  }
  return files
}

function sortFiles(files: readonly CodeGraphFileInput[]): CodeGraphFileInput[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function sortSymbols(symbols: readonly CodeGraphSymbolInput[]): CodeGraphSymbolInput[] {
  return [...symbols].sort((left, right) =>
    left.filePath.localeCompare(right.filePath, 'en') ||
    left.startByte - right.startByte ||
    left.stableId.localeCompare(right.stableId, 'en')
  )
}

function dedupeAndSortFileEdges(
  edges: readonly CodeGraphFileEdgeInput[]
): CodeGraphFileEdgeInput[] {
  return dedupeBy(edges, (edge) =>
    `${edge.sourcePath}:${edge.targetPath}:${edge.kind}:${edge.sourceLine}`
  ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
}

function dedupeAndSortSymbolEdges(
  edges: readonly CodeGraphSymbolEdgeInput[]
): CodeGraphSymbolEdgeInput[] {
  return dedupeBy(edges, (edge) =>
    `${edge.sourceSymbolId}:${edge.targetSymbolId}:${edge.kind}:${edge.sourceLine}`
  ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
}

function dedupeAndSortUnresolved(
  relations: readonly CodeGraphUnresolvedRelationInput[]
): CodeGraphUnresolvedRelationInput[] {
  return dedupeBy(relations, (relation) =>
    `${relation.filePath}:${relation.sourceSymbolId}:${relation.kind}:` +
    `${relation.rawTarget}:${relation.moduleSpecifier}:${relation.sourceLine}:${relation.reason}`
  ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
}

function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}
