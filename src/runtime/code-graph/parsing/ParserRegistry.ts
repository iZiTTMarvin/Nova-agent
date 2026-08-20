import type {
  CodeFileParseStatus,
  CodeGraphLanguage,
  CodeSymbolEdgeKind,
  CodeSymbolKind
} from '../types'

export interface StructuralParseInput {
  readonly path: string
  readonly language: Exclude<CodeGraphLanguage, 'unsupported'>
  readonly source: string
}

export interface ParsedImportBinding {
  readonly localName: string
  /** null 表示 namespace/module binding，不对应单个导出名。 */
  readonly importedName: string | null
}

export interface ParsedImport {
  readonly moduleSpecifier: string
  readonly kind: 'import' | 're_export'
  readonly bindings: readonly ParsedImportBinding[]
  readonly sourceLine: number
}

export interface ParsedExport {
  readonly exportedName: string
  readonly localName: string | null
  readonly moduleSpecifier: string | null
  readonly importedName: string | null
  readonly wildcard: boolean
  readonly sourceLine: number
}

export interface ParsedSymbol {
  readonly stableId: string
  readonly name: string
  readonly qualifiedName: string
  readonly kind: CodeSymbolKind
  readonly exported: boolean
  readonly signature: string | null
  readonly docExcerpt: string | null
  readonly startLine: number
  readonly endLine: number
  readonly startByte: number
  readonly endByte: number
}

export interface ParsedCall {
  readonly sourceSymbolId: string
  readonly rawTarget: string
  readonly bindingName: string | null
  readonly sourceLine: number
}

export interface ParsedReference {
  readonly sourceSymbolId: string
  readonly rawTarget: string
  readonly localBinding: string
  readonly sourceLine: number
}

export interface ParsedInheritance {
  readonly sourceSymbolId: string
  readonly rawTarget: string
  readonly kind: Extract<CodeSymbolEdgeKind, 'extends' | 'implements'>
  readonly sourceLine: number
}

export interface ParsedSourceFile {
  readonly path: string
  readonly language: Exclude<CodeGraphLanguage, 'unsupported'>
  readonly contentHash: string
  readonly sizeBytes: number
  readonly lineCount: number
  readonly parseStatus: Extract<CodeFileParseStatus, 'parsed' | 'failed'>
  readonly parseErrorCount: number
  readonly symbols: readonly ParsedSymbol[]
  readonly imports: readonly ParsedImport[]
  readonly exports: readonly ParsedExport[]
  readonly calls: readonly ParsedCall[]
  readonly references: readonly ParsedReference[]
  readonly inheritance: readonly ParsedInheritance[]
}

export interface StructuralParser {
  readonly signature: string
  parse(input: StructuralParseInput): Promise<ParsedSourceFile>
}

/** 语言选择的唯一入口；parser 本身不决定跨文件关系。 */
export class ParserRegistry {
  private readonly parsers: ReadonlyMap<StructuralParseInput['language'], StructuralParser>

  constructor(
    registrations: ReadonlyMap<StructuralParseInput['language'], StructuralParser>
  ) {
    this.parsers = new Map(registrations)
  }

  get signature(): string {
    const signatures = [...new Set(
      [...this.parsers.values()].map((parser) => parser.signature)
    )]
    return signatures.sort().join('|')
  }

  async parse(input: StructuralParseInput): Promise<ParsedSourceFile> {
    const parser = this.parsers.get(input.language)
    if (!parser) throw new Error(`未注册 ${input.language} 结构解析器`)
    return parser.parse(input)
  }
}
