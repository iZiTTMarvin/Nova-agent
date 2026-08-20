import { createHash } from 'node:crypto'
import { Language, Parser, type Node } from 'web-tree-sitter'
import { CODE_INDEX_MAX_SOURCE_BYTES } from '../indexing/FileDiscovery'
import type { CodeGraphLanguage, CodeSymbolEdgeKind, CodeSymbolKind } from '../types'
import {
  ParserRegistry,
  type ParsedCall,
  type ParsedExport,
  type ParsedImport,
  type ParsedImportBinding,
  type ParsedInheritance,
  type ParsedReference,
  type ParsedSourceFile,
  type ParsedSymbol,
  type StructuralParseInput,
  type StructuralParser
} from './ParserRegistry'

export const TREE_SITTER_PARSER_SIGNATURE =
  'web-tree-sitter@0.26.12;vscode-grammars@0.3.1;structural-v1'

type GrammarKey = 'javascript' | 'typescript' | 'tsx' | 'python'

export interface TreeSitterGrammarPaths {
  readonly javascript: string
  readonly typescript: string
  readonly tsx: string
  readonly python: string
}

export interface TreeSitterParserOptions {
  readonly coreWasmPath: string
  readonly grammarWasmPaths: TreeSitterGrammarPaths
  readonly signature?: string
}

export class TreeSitterResourceError extends Error {
  readonly code = 'grammar_missing' as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TreeSitterResourceError'
  }
}

/** 只做单文件结构抽取；跨文件绑定与置信度判定由 Resolver 负责。 */
export class TreeSitterParser implements StructuralParser {
  readonly signature: string
  private readonly languages = new Map<GrammarKey, Promise<Language>>()

  private constructor(private readonly options: TreeSitterParserOptions) {
    this.signature = options.signature ?? TREE_SITTER_PARSER_SIGNATURE
  }

  static async create(options: TreeSitterParserOptions): Promise<TreeSitterParser> {
    try {
      await Parser.init({ locateFile: () => options.coreWasmPath })
    } catch (error) {
      throw new TreeSitterResourceError('Tree-sitter runtime WASM 无法加载', {
        cause: error
      })
    }
    return new TreeSitterParser(options)
  }

  async parse(input: StructuralParseInput): Promise<ParsedSourceFile> {
    const sizeBytes = Buffer.byteLength(input.source, 'utf8')
    if (sizeBytes > CODE_INDEX_MAX_SOURCE_BYTES) {
      throw new Error(`源码超过 ${CODE_INDEX_MAX_SOURCE_BYTES} 字节解析上限`)
    }

    const language = await this.loadLanguage(grammarKeyFor(input.language))
    const parser = new Parser()
    try {
      parser.setLanguage(language)
      const tree = parser.parse(input.source)
      if (!tree) throw new Error('Tree-sitter 未返回语法树')
      try {
        return buildParseResult(input, tree.rootNode, sizeBytes)
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  }

  private loadLanguage(grammar: GrammarKey): Promise<Language> {
    const cached = this.languages.get(grammar)
    if (cached) return cached
    const loading = Language.load(this.options.grammarWasmPaths[grammar]).catch((error) => {
      this.languages.delete(grammar)
      throw new TreeSitterResourceError(`${grammar} grammar WASM 无法加载`, {
        cause: error
      })
    })
    this.languages.set(grammar, loading)
    return loading
  }
}

export async function createTreeSitterParserRegistry(
  options: TreeSitterParserOptions
): Promise<ParserRegistry> {
  const parser = await TreeSitterParser.create(options)
  const registrations = new Map<StructuralParseInput['language'], StructuralParser>()
  for (const language of [
    'typescript', 'tsx', 'javascript', 'jsx', 'mjs', 'cjs', 'python'
  ] as const) {
    registrations.set(language, parser)
  }
  return new ParserRegistry(registrations)
}

function buildParseResult(
  input: StructuralParseInput,
  root: Node,
  sizeBytes: number
): ParsedSourceFile {
  const nodes = collectNamedNodes(root)
  const parseErrorCount = nodes.filter(
    (node) => node.type === 'ERROR' || node.isMissing
  ).length
  const moduleSymbol = createModuleSymbol(input, root)
  const symbols = [moduleSymbol]
  const symbolByRange = new Map<string, ParsedSymbol>()
  for (const node of nodes) {
    const symbol = createSymbol(input, node)
    if (!symbol) continue
    symbols.push(symbol)
    symbolByRange.set(rangeKey(node), symbol)
  }

  const imports = input.language === 'python'
    ? extractPythonImports(nodes)
    : extractJavaScriptImports(nodes)
  const exports = input.language === 'python'
    ? extractPythonExports(symbols)
    : extractJavaScriptExports(nodes, symbolByRange)
  const importBindings = new Set(
    imports.flatMap((item) => item.bindings.map((binding) => binding.localName))
  )
  const calls = extractCalls(input, nodes, moduleSymbol, symbolByRange, importBindings)
  const references = extractReferences(
    input,
    nodes,
    moduleSymbol,
    symbolByRange,
    importBindings
  )
  const inheritance = extractInheritance(
    input,
    nodes,
    moduleSymbol,
    symbolByRange
  )

  const parsed = parseErrorCount === 0
  return Object.freeze({
    path: input.path,
    language: input.language,
    contentHash: createHash('sha256').update(input.source).digest('hex'),
    sizeBytes,
    lineCount: countLines(input.source),
    parseStatus: parsed ? 'parsed' : 'failed',
    parseErrorCount,
    symbols: Object.freeze(parsed ? sortSymbols(symbols) : [moduleSymbol]),
    imports: Object.freeze(parsed ? sortByLocation(imports) : []),
    exports: Object.freeze(parsed ? sortByLocation(exports) : []),
    calls: Object.freeze(parsed ? sortByLocation(calls) : []),
    references: Object.freeze(parsed ? sortByLocation(references) : []),
    inheritance: Object.freeze(parsed ? sortByLocation(inheritance) : [])
  })
}

function createModuleSymbol(input: StructuralParseInput, root: Node): ParsedSymbol {
  const name = input.path.split('/').pop() ?? input.path
  return Object.freeze({
    stableId: `${input.path}:module`,
    name,
    qualifiedName: input.path,
    kind: 'module',
    exported: false,
    signature: null,
    docExcerpt: null,
    startLine: 1,
    endLine: root.endPosition.row + 1,
    startByte: 0,
    endByte: root.endIndex
  })
}

function createSymbol(
  input: StructuralParseInput,
  node: Node
): ParsedSymbol | null {
  const descriptor = symbolDescriptor(node, input.language)
  if (!descriptor) return null
  const ancestors = symbolAncestorNames(node, input.language)
  const qualifiedName = [...ancestors, descriptor.name].join('.')
  return Object.freeze({
    stableId: stableSymbolId(input.path, descriptor.kind, descriptor.name, node.startIndex),
    name: descriptor.name,
    qualifiedName,
    kind: descriptor.kind,
    exported: isExported(node, descriptor.name, input.language),
    signature: extractSignature(node),
    docExcerpt: extractDocExcerpt(node),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex
  })
}

function symbolDescriptor(
  node: Node,
  language: StructuralParseInput['language']
): { readonly name: string; readonly kind: CodeSymbolKind } | null {
  const nameNode = node.childForFieldName('name')
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      return namedDescriptor(nameNode, 'function')
    case 'function_definition':
      return namedDescriptor(
        nameNode,
        hasAncestorType(node, 'class_definition') ? 'method' : 'function'
      )
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class_definition':
      return namedDescriptor(nameNode, 'class')
    case 'interface_declaration':
      return namedDescriptor(nameNode, 'interface')
    case 'type_alias_declaration':
      return namedDescriptor(nameNode, 'type')
    case 'enum_declaration':
      return namedDescriptor(nameNode, 'enum')
    case 'enum_assignment':
      return namedDescriptor(nameNode, 'enum_member')
    case 'method_definition':
    case 'method_signature':
    case 'abstract_method_signature':
      return namedDescriptor(nameNode, node.text.trimStart().startsWith('constructor')
        ? 'constructor'
        : 'method')
    case 'variable_declarator': {
      const value = node.childForFieldName('value')
      if (!value || !['arrow_function', 'function_expression'].includes(value.type)) return null
      return namedDescriptor(nameNode, declarationKind(node))
    }
    default:
      return null
  }
}

function namedDescriptor(
  nameNode: Node | null,
  kind: CodeSymbolKind
): { readonly name: string; readonly kind: CodeSymbolKind } | null {
  const name = nameNode?.text.trim()
  return name ? { name, kind } : null
}

function declarationKind(node: Node): CodeSymbolKind {
  const declaration = findAncestor(node, ['lexical_declaration', 'variable_declaration'])
  return declaration?.text.trimStart().startsWith('const ') ? 'constant' : 'function'
}

function extractJavaScriptImports(nodes: readonly Node[]): ParsedImport[] {
  const imports: ParsedImport[] = []
  for (const node of nodes) {
    if (node.type === 'import_statement') {
      const source = stringValue(node.childForFieldName('source'))
      if (!source) continue
      imports.push(Object.freeze({
        moduleSpecifier: source,
        kind: 'import',
        bindings: Object.freeze(importBindings(node)),
        sourceLine: node.startPosition.row + 1
      }))
      continue
    }
    if (node.type === 'export_statement') {
      const source = stringValue(node.childForFieldName('source'))
      if (!source) continue
      imports.push(Object.freeze({
        moduleSpecifier: source,
        kind: 're_export',
        bindings: Object.freeze(exportBindings(node)),
        sourceLine: node.startPosition.row + 1
      }))
      continue
    }
    if (node.type === 'call_expression' && callTarget(node) === 'require') {
      const args = node.childForFieldName('arguments')
      const source = stringValue(args?.namedChild(0) ?? null)
      if (!source) continue
      imports.push(Object.freeze({
        moduleSpecifier: source,
        kind: 'import',
        bindings: Object.freeze(requireBindings(node)),
        sourceLine: node.startPosition.row + 1
      }))
    }
  }
  return dedupeBy(imports, (item) =>
    `${item.kind}:${item.moduleSpecifier}:${item.sourceLine}:${JSON.stringify(item.bindings)}`
  )
}

function importBindings(node: Node): ParsedImportBinding[] {
  const clause = node.namedChildren.find((child) => child.type === 'import_clause')
  if (!clause) return []
  const bindings: ParsedImportBinding[] = []
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      bindings.push({ localName: child.text, importedName: 'default' })
    } else if (child.type === 'namespace_import') {
      const local = child.namedChildren.find((item) => item.type === 'identifier')
      if (local) bindings.push({ localName: local.text, importedName: null })
    } else if (child.type === 'named_imports') {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== 'import_specifier') continue
        const imported = specifier.childForFieldName('name')
        const alias = specifier.childForFieldName('alias')
        if (imported) {
          bindings.push({
            localName: alias?.text ?? imported.text,
            importedName: imported.text
          })
        }
      }
    }
  }
  return bindings
}

function exportBindings(node: Node): ParsedImportBinding[] {
  const clause = node.namedChildren.find((child) => child.type === 'export_clause')
  if (!clause) return []
  const bindings: ParsedImportBinding[] = []
  for (const specifier of clause.namedChildren) {
    const imported = specifier.childForFieldName('name')
    const alias = specifier.childForFieldName('alias')
    if (!imported) continue
    bindings.push({
      localName: alias?.text ?? imported.text,
      importedName: imported.text
    })
  }
  return bindings
}

function requireBindings(call: Node): ParsedImportBinding[] {
  const declarator = findAncestor(call, ['variable_declarator'])
  const name = declarator?.childForFieldName('name')
  if (!name) return []
  if (name.type === 'identifier') return [{ localName: name.text, importedName: null }]
  if (name.type === 'object_pattern') {
    return name.namedChildren.flatMap((child) => {
      if (child.type === 'shorthand_property_identifier_pattern') {
        return [{ localName: child.text, importedName: child.text }]
      }
      const imported = child.childForFieldName('key') ?? child.childForFieldName('name')
      const local = child.childForFieldName('value') ?? child.childForFieldName('alias') ?? imported
      return imported && local
        ? [{ localName: local.text, importedName: imported.text }]
        : []
    })
  }
  return []
}

function extractPythonImports(nodes: readonly Node[]): ParsedImport[] {
  const imports: ParsedImport[] = []
  for (const node of nodes) {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        const parsed = pythonImportName(child)
        if (!parsed) continue
        imports.push(Object.freeze({
          moduleSpecifier: parsed.moduleSpecifier,
          kind: 'import',
          bindings: Object.freeze([{
            localName: parsed.localName,
            importedName: null
          }]),
          sourceLine: node.startPosition.row + 1
        }))
      }
    } else if (node.type === 'import_from_statement') {
      const moduleName = node.childForFieldName('module_name')?.text.trim()
      if (!moduleName) continue
      const bindings: ParsedImportBinding[] = []
      for (const child of node.namedChildren) {
        if (child === node.childForFieldName('module_name')) continue
        if (child.type === 'wildcard_import') continue
        const parsed = pythonImportedBinding(child)
        if (parsed) bindings.push(parsed)
      }
      imports.push(Object.freeze({
        moduleSpecifier: moduleName,
        kind: 'import',
        bindings: Object.freeze(bindings),
        sourceLine: node.startPosition.row + 1
      }))
    }
  }
  return imports
}

function pythonImportName(
  node: Node
): { readonly moduleSpecifier: string; readonly localName: string } | null {
  if (node.type === 'aliased_import') {
    const name = node.childForFieldName('name')
    const alias = node.childForFieldName('alias')
    return name && alias
      ? { moduleSpecifier: name.text, localName: alias.text }
      : null
  }
  if (node.type === 'dotted_name') {
    return { moduleSpecifier: node.text, localName: node.text.split('.')[0] ?? node.text }
  }
  return null
}

function pythonImportedBinding(node: Node): ParsedImportBinding | null {
  if (node.type === 'aliased_import') {
    const name = node.childForFieldName('name')
    const alias = node.childForFieldName('alias')
    return name && alias
      ? { localName: alias.text, importedName: name.text }
      : null
  }
  if (node.type === 'dotted_name' || node.type === 'identifier') {
    return { localName: node.text, importedName: node.text }
  }
  return null
}

function extractJavaScriptExports(
  nodes: readonly Node[],
  symbolByRange: ReadonlyMap<string, ParsedSymbol>
): ParsedExport[] {
  const exports: ParsedExport[] = []
  for (const node of nodes) {
    if (node.type === 'assignment_expression') {
      exports.push(...commonJsExports(node))
      continue
    }
    if (node.type !== 'export_statement') continue
    const source = stringValue(node.childForFieldName('source'))
    const clause = node.namedChildren.find((child) => child.type === 'export_clause')
    if (clause) {
      for (const specifier of clause.namedChildren) {
        const local = specifier.childForFieldName('name')
        const alias = specifier.childForFieldName('alias')
        if (!local) continue
        exports.push(Object.freeze({
          exportedName: alias?.text ?? local.text,
          localName: source ? null : local.text,
          moduleSpecifier: source,
          importedName: source ? local.text : null,
          wildcard: false,
          sourceLine: node.startPosition.row + 1
        }))
      }
      continue
    }
    if (source && /^export\s+\*/.test(node.text.trim())) {
      exports.push(Object.freeze({
        exportedName: '*',
        localName: null,
        moduleSpecifier: source,
        importedName: '*',
        wildcard: true,
        sourceLine: node.startPosition.row + 1
      }))
      continue
    }
    const declaration = node.childForFieldName('declaration') ??
      node.namedChildren.find((child) => symbolByRange.has(rangeKey(child)))
    if (declaration) {
      const symbol = symbolByRange.get(rangeKey(declaration))
      if (symbol) {
        exports.push(Object.freeze({
          exportedName: /^export\s+default\b/.test(node.text.trim()) ? 'default' : symbol.name,
          localName: symbol.name,
          moduleSpecifier: null,
          importedName: null,
          wildcard: false,
          sourceLine: node.startPosition.row + 1
        }))
      }
      continue
    }
    const defaultMatch = node.text.trim().match(/^export\s+default\s+([A-Za-z_$][\w$]*)/)
    if (defaultMatch?.[1]) {
      exports.push(Object.freeze({
        exportedName: 'default',
        localName: defaultMatch[1],
        moduleSpecifier: null,
        importedName: null,
        wildcard: false,
        sourceLine: node.startPosition.row + 1
      }))
    }
  }
  return dedupeBy(exports, exportKey)
}

function commonJsExports(node: Node): ParsedExport[] {
  if (findAncestor(node, [
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition'
  ])) {
    return []
  }
  const left = node.childForFieldName('left')?.text.replace(/\s+/g, '')
  const right = node.childForFieldName('right')
  if (!left || !right) return []

  if (left === 'module.exports') {
    if (right.type === 'identifier') {
      return [commonJsExport('default', right.text, node)]
    }
    if (right.type !== 'object') return []
    return right.namedChildren.flatMap((child) => {
      if (child.type === 'shorthand_property_identifier') {
        return [commonJsExport(child.text, child.text, node)]
      }
      if (child.type !== 'pair') return []
      const key = child.childForFieldName('key')
      const value = child.childForFieldName('value')
      const exportedName = key?.type === 'string' ? stringValue(key) : key?.text
      return exportedName && value?.type === 'identifier'
        ? [commonJsExport(exportedName, value.text, node)]
        : []
    })
  }

  const member = left.match(/^(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)$/)?.[1]
  return member && right.type === 'identifier'
    ? [commonJsExport(member, right.text, node)]
    : []
}

function commonJsExport(
  exportedName: string,
  localName: string,
  node: Node
): ParsedExport {
  return Object.freeze({
    exportedName,
    localName,
    moduleSpecifier: null,
    importedName: null,
    wildcard: false,
    sourceLine: node.startPosition.row + 1
  })
}

function extractPythonExports(symbols: readonly ParsedSymbol[]): ParsedExport[] {
  return symbols
    .filter((symbol) => symbol.kind !== 'module' && symbol.exported)
    .map((symbol) => Object.freeze({
      exportedName: symbol.name,
      localName: symbol.name,
      moduleSpecifier: null,
      importedName: null,
      wildcard: false,
      sourceLine: symbol.startLine
    }))
}

function extractCalls(
  input: StructuralParseInput,
  nodes: readonly Node[],
  moduleSymbol: ParsedSymbol,
  symbolByRange: ReadonlyMap<string, ParsedSymbol>,
  importBindings: ReadonlySet<string>
): ParsedCall[] {
  const calls: ParsedCall[] = []
  for (const node of nodes) {
    if (!isCallNode(node, input.language)) continue
    const target = callTarget(node)
    if (!target || target === 'require' || target === 'import') continue
    calls.push(Object.freeze({
      sourceSymbolId: containingSymbolId(node, moduleSymbol, symbolByRange),
      rawTarget: target,
      sourceLine: node.startPosition.row + 1,
      bindingName: importBindings.has(rootIdentifier(target))
        ? rootIdentifier(target)
        : null
    }))
  }
  return calls
}

function extractReferences(
  input: StructuralParseInput,
  nodes: readonly Node[],
  moduleSymbol: ParsedSymbol,
  symbolByRange: ReadonlyMap<string, ParsedSymbol>,
  importBindings: ReadonlySet<string>
): ParsedReference[] {
  const references: ParsedReference[] = []
  for (const node of nodes) {
    if (node.type !== 'identifier' && node.type !== 'type_identifier') continue
    if (!importBindings.has(node.text) || isInsideImport(node)) continue
    const target = expandMemberTarget(node)
    if (isCallTargetNode(node)) continue
    references.push(Object.freeze({
      sourceSymbolId: containingSymbolId(node, moduleSymbol, symbolByRange),
      rawTarget: target,
      localBinding: node.text,
      sourceLine: node.startPosition.row + 1
    }))
  }
  return dedupeBy(references, (item) =>
    `${item.sourceSymbolId}:${item.rawTarget}:${item.sourceLine}`
  )
}

function extractInheritance(
  input: StructuralParseInput,
  nodes: readonly Node[],
  moduleSymbol: ParsedSymbol,
  symbolByRange: ReadonlyMap<string, ParsedSymbol>
): ParsedInheritance[] {
  const relations: ParsedInheritance[] = []
  for (const node of nodes) {
    const descriptor = symbolDescriptor(node, input.language)
    if (!descriptor || !['class', 'interface'].includes(descriptor.kind)) continue
    const sourceSymbolId = symbolByRange.get(rangeKey(node))?.stableId ??
      containingSymbolId(node, moduleSymbol, symbolByRange)
    if (input.language === 'python') {
      const superclasses = node.childForFieldName('superclasses')
      for (const target of superclasses?.namedChildren ?? []) {
        relations.push(inheritance(sourceSymbolId, target.text, 'extends', target))
      }
      continue
    }
    for (const clause of node.descendantsOfType([
      'extends_clause', 'implements_clause', 'extends_type_clause'
    ])) {
      const kind: ParsedInheritance['kind'] = clause.type === 'implements_clause'
        ? 'implements'
        : 'extends'
      for (const target of clause.namedChildren) {
        relations.push(inheritance(sourceSymbolId, target.text, kind, target))
      }
    }
  }
  return dedupeBy(relations, (item) =>
    `${item.sourceSymbolId}:${item.kind}:${item.rawTarget}:${item.sourceLine}`
  )
}

function inheritance(
  sourceSymbolId: string,
  rawTarget: string,
  kind: Extract<CodeSymbolEdgeKind, 'extends' | 'implements'>,
  node: Node
): ParsedInheritance {
  return Object.freeze({
    sourceSymbolId,
    rawTarget,
    kind,
    sourceLine: node.startPosition.row + 1
  })
}

function containingSymbolId(
  node: Node,
  moduleSymbol: ParsedSymbol,
  symbolByRange: ReadonlyMap<string, ParsedSymbol>
): string {
  let current = node.parent
  while (current) {
    const symbol = symbolByRange.get(rangeKey(current))
    if (symbol) return symbol.stableId
    current = current.parent
  }
  return moduleSymbol.stableId
}

function symbolAncestorNames(
  node: Node,
  language: StructuralParseInput['language']
): string[] {
  const names: string[] = []
  let current = node.parent
  while (current) {
    const descriptor = symbolDescriptor(current, language)
    if (descriptor && ['class', 'interface', 'function', 'method'].includes(descriptor.kind)) {
      names.push(descriptor.name)
    }
    current = current.parent
  }
  return names.reverse()
}

function isExported(
  node: Node,
  name: string,
  language: StructuralParseInput['language']
): boolean {
  if (language === 'python') {
    return node.parent?.type === 'module' && !name.startsWith('_')
  }
  return hasAncestorType(node, 'export_statement')
}

function extractSignature(node: Node): string | null {
  const body = node.childForFieldName('body')
  let signature = node.text.trim()
  if (body) {
    const bodyOffset = signature.lastIndexOf(body.text)
    if (bodyOffset >= 0) signature = signature.slice(0, bodyOffset).trimEnd()
  }
  signature = signature.replace(/\s+/g, ' ').trim()
  return signature ? signature.slice(0, 512) : null
}

function extractDocExcerpt(node: Node): string | null {
  const previous = node.previousNamedSibling
  if (!previous || previous.type !== 'comment') return null
  const excerpt = previous.text
    .replace(/^\s*(?:\/\*+|\/\/|#)\s?/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return excerpt ? excerpt.slice(0, 512) : null
}

function callTarget(node: Node): string | null {
  const target = node.childForFieldName('function')
  return target?.text.trim() || null
}

function isCallNode(node: Node, language: CodeGraphLanguage): boolean {
  return language === 'python' ? node.type === 'call' : node.type === 'call_expression'
}

function isInsideImport(node: Node): boolean {
  return Boolean(findAncestor(node, [
    'import_statement', 'import_from_statement', 'import_clause', 'export_statement'
  ]))
}

function isCallTargetNode(node: Node): boolean {
  let current: Node = node
  let parent = current.parent
  while (parent && ['member_expression', 'subscript_expression', 'attribute'].includes(parent.type)) {
    const object = parent.childForFieldName('object')
    if (!sameRange(object, current)) break
    current = parent
    parent = parent.parent
  }
  return Boolean(parent && ['call_expression', 'call'].includes(parent.type) &&
    sameRange(parent.childForFieldName('function'), current))
}

function expandMemberTarget(node: Node): string {
  let current = node
  while (current.parent && ['member_expression', 'attribute'].includes(current.parent.type)) {
    const object = current.parent.childForFieldName('object')
    if (!sameRange(object, current)) break
    current = current.parent
  }
  return current.text
}

function rootIdentifier(target: string): string {
  return target.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? target
}

function stringValue(node: Node | null): string | null {
  if (!node) return null
  const value = node.text.trim()
  if (value.length < 2) return null
  const quote = value[0]
  if (!quote || !['"', "'", '`'].includes(quote) || value[value.length - 1] !== quote) {
    return null
  }
  return value.slice(1, -1)
}

function stableSymbolId(
  filePath: string,
  kind: CodeSymbolKind,
  name: string,
  startByte: number
): string {
  return `${filePath}:${kind}:${name}:${startByte}`
}

function collectNamedNodes(root: Node): Node[] {
  const nodes: Node[] = []
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) break
    nodes.push(node)
    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
      const child = node.namedChild(index)
      if (child) pending.push(child)
    }
  }
  return nodes
}

function findAncestor(node: Node, types: readonly string[]): Node | null {
  let current = node.parent
  while (current) {
    if (types.includes(current.type)) return current
    current = current.parent
  }
  return null
}

function hasAncestorType(node: Node, type: string): boolean {
  return findAncestor(node, [type]) !== null
}

function sameRange(left: Node | null, right: Node | null): boolean {
  return Boolean(left && right &&
    left.startIndex === right.startIndex && left.endIndex === right.endIndex)
}

function rangeKey(node: Node): string {
  return `${node.type}:${node.startIndex}:${node.endIndex}`
}

function grammarKeyFor(language: StructuralParseInput['language']): GrammarKey {
  switch (language) {
    case 'typescript': return 'typescript'
    case 'tsx': return 'tsx'
    case 'python': return 'python'
    case 'javascript':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
  }
}

function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/).length
}

function sortSymbols(symbols: readonly ParsedSymbol[]): ParsedSymbol[] {
  return [...symbols].sort((left, right) =>
    left.startByte - right.startByte || left.stableId.localeCompare(right.stableId, 'en')
  )
}

function sortByLocation<T extends { readonly sourceLine: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) =>
    left.sourceLine - right.sourceLine || JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')
  )
}

function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  return deduped
}

function exportKey(item: ParsedExport): string {
  return `${item.exportedName}:${item.localName}:${item.moduleSpecifier}:${item.sourceLine}`
}
