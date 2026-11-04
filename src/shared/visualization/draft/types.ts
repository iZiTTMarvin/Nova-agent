export type VisualizationDraftIssue = {
  readonly line: number
  readonly column: number | null
  readonly code: string
  readonly message: string
  readonly correctExample: string | null
}

export type VisualizationDraftCompileResult =
  | { readonly status: 'ok'; readonly html: string; readonly panelCount: number; readonly diagnostics: readonly VisualizationDraftIssue[] }
  | { readonly status: 'preview'; readonly html: string | null; readonly completePanelCount: number; readonly diagnostics: readonly VisualizationDraftIssue[] }
  | { readonly status: 'invalid'; readonly issues: readonly VisualizationDraftIssue[] }

export interface DraftAttribute {
  readonly name: string
  readonly value: string
  readonly column: number
}

export type DraftBlock =
  | { readonly type: 'paragraph'; readonly line: number; readonly text: string }
  | { readonly type: 'list'; readonly line: number; readonly ordered: boolean; readonly items: readonly string[] }
  | {
      readonly type: 'component'
      readonly line: number
      readonly bodyLine: number
      readonly kind: string
      readonly attributes: readonly DraftAttribute[]
      readonly body: string
    }

export interface DraftPanel {
  readonly line: number
  readonly title: string
  readonly blocks: readonly DraftBlock[]
  readonly terminated: boolean
}

export interface DraftParseResult {
  readonly panels: readonly DraftPanel[]
  readonly issues: readonly VisualizationDraftIssue[]
}
