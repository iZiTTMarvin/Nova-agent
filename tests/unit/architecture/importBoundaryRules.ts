/**
 * 依赖边界规则：层级判定与违规比对的纯函数。
 * 判定真源在此；allowlist 只冻结精确历史债务边。
 */

export const SRC_LAYERS = ['shared', 'runtime', 'renderer', 'main', 'preload'] as const
export type SrcLayer = (typeof SRC_LAYERS)[number]

export type BoundaryViolation = {
  from: string
  to: string
  rule: string
  specifier: string
}

export type AllowedBoundaryDebt = {
  from: string
  to: string
  rule: string
  reason: string
}

export type UnscannableImport = {
  from: string
  kind: 'dynamic-import' | 'require'
  detail: string
}

/** 各层禁止依赖的目标层 */
export const FORBIDDEN_LAYER_EDGES: Readonly<Record<SrcLayer, readonly SrcLayer[]>> = {
  shared: ['runtime', 'main', 'preload', 'renderer'],
  runtime: ['main', 'preload', 'renderer'],
  renderer: ['runtime', 'main', 'preload'],
  main: ['renderer', 'preload'],
  preload: ['main', 'runtime', 'renderer']
}

export const RULE_RUNTIME_RUN_WORKFLOW = 'runtime-run-cannot-import-workflow'

export function layerCannotImportRule(from: SrcLayer, to: SrcLayer): string {
  return `${from}-cannot-import-${to}`
}

/** 统一为仓库相对 POSIX 路径，保证 Windows / CI 结果一致 */
export function toRepoPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function layerOf(repoRelativePosix: string): SrcLayer | null {
  const normalized = toRepoPosixPath(repoRelativePosix)
  const match = /^src\/(shared|runtime|renderer|main|preload)(?:\/|$)/.exec(normalized)
  return match ? (match[1] as SrcLayer) : null
}

export function isRuntimeRunPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/runtime/run/')
}

export function isRuntimeWorkflowPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/runtime/workflow/')
}

export function violationKey(edge: Pick<BoundaryViolation, 'from' | 'to' | 'rule'>): string {
  return `${edge.from}\0${edge.to}\0${edge.rule}`
}

/**
 * 根据已解析的 from/to 文件边计算命中的规则（可能为空）。
 * 同层边仅检查 runtime/run → runtime/workflow 特化规则。
 */
export function rulesForResolvedEdge(fromFile: string, toFile: string): string[] {
  const from = toRepoPosixPath(fromFile)
  const to = toRepoPosixPath(toFile)
  const fromLayer = layerOf(from)
  const toLayer = layerOf(to)
  if (!fromLayer || !toLayer) return []

  const rules: string[] = []
  if (FORBIDDEN_LAYER_EDGES[fromLayer].includes(toLayer)) {
    rules.push(layerCannotImportRule(fromLayer, toLayer))
  }
  if (isRuntimeRunPath(from) && isRuntimeWorkflowPath(to)) {
    rules.push(RULE_RUNTIME_RUN_WORKFLOW)
  }
  return rules
}

export function buildViolationsForEdge(
  fromFile: string,
  toFile: string,
  specifier: string
): BoundaryViolation[] {
  const from = toRepoPosixPath(fromFile)
  const to = toRepoPosixPath(toFile)
  return rulesForResolvedEdge(from, to).map((rule) => ({
    from,
    to,
    rule,
    specifier
  }))
}

export type BoundaryReconcileResult = {
  unexpected: BoundaryViolation[]
  stale: AllowedBoundaryDebt[]
}

/** 双向约束：新违规必须失败；allowlist 中已消失的债务也必须失败 */
export function reconcileBoundaryDebts(
  found: BoundaryViolation[],
  allowlist: AllowedBoundaryDebt[]
): BoundaryReconcileResult {
  const foundByKey = new Map<string, BoundaryViolation>()
  for (const v of found) {
    foundByKey.set(violationKey(v), v)
  }

  const allowedKeys = new Set(allowlist.map(violationKey))

  const unexpected = [...foundByKey.values()]
    .filter((v) => !allowedKeys.has(violationKey(v)))
    .sort(compareViolation)

  const stale = allowlist
    .filter((entry) => !foundByKey.has(violationKey(entry)))
    .sort(compareViolation)

  return { unexpected, stale }
}

export function formatViolation(v: Pick<BoundaryViolation, 'from' | 'to' | 'rule'>): string {
  return `${v.from} -> ${v.to} [${v.rule}]`
}

function compareViolation(
  a: Pick<BoundaryViolation, 'from' | 'to' | 'rule'>,
  b: Pick<BoundaryViolation, 'from' | 'to' | 'rule'>
): number {
  return formatViolation(a).localeCompare(formatViolation(b))
}

export function formatReconcileFailure(result: BoundaryReconcileResult): string {
  const lines: string[] = []
  if (result.unexpected.length > 0) {
    lines.push('新增依赖边界违规（不在 allowlist 中）：')
    for (const v of result.unexpected) {
      lines.push(`  ${formatViolation(v)}  (specifier: ${v.specifier})`)
    }
  }
  if (result.stale.length > 0) {
    lines.push('过期 allowlist 项（债务已消失，请删除对应条目）：')
    for (const v of result.stale) {
      lines.push(`  ${formatViolation(v)}`)
    }
  }
  return lines.join('\n')
}
