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
export const RULE_MAIN_SERVICES_CANNOT_IMPORT_IPC = 'main-services-cannot-import-ipc'
export const RULE_MAIN_AGENT_CANNOT_IMPORT_IPC = 'main-agent-cannot-import-ipc'
export const RULE_AGENT_LOOP_CANNOT_IMPORT_PRODUCT_EXECUTORS =
  'agent-loop-cannot-import-product-executors'
export const RULE_AGENT_CORE_CANNOT_IMPORT_PRODUCT_ROUTING =
  'agent-core-cannot-import-product-routing'
export const RULE_RUNTIME_CANNOT_IMPORT_ELECTRON = 'runtime-cannot-import-electron'
export const RULE_CHAT_SLICE_CANNOT_IMPORT_STORE_ROOT =
  'chat-slice-cannot-import-store-root'
export const RULE_CHAT_SLICES_CANNOT_IMPORT_EACH_OTHER =
  'chat-slices-cannot-import-each-other'
export const RULE_CHAT_SLICE_CANNOT_IMPORT_RENDERER_UI =
  'chat-slice-cannot-import-renderer-ui'
export const RULE_CHAT_SLICE_CANNOT_IMPORT_LEGACY_STORE_TYPES =
  'chat-slice-cannot-import-legacy-store-types'
export const RULE_CHAT_INTERNAL_CANNOT_IMPORT_SLICES =
  'chat-internal-cannot-import-slices'
export const RULE_CHAT_INTERNAL_CANNOT_IMPORT_STORE_ROOT =
  'chat-internal-cannot-import-store-root'
export const RULE_CHAT_INTERNAL_CANNOT_IMPORT_RENDERER_IMPLEMENTATION =
  'chat-internal-cannot-import-renderer-implementation'
export const RULE_COMPONENTS_CANNOT_IMPORT_CHAT_INTERNALS =
  'components-cannot-import-chat-internals'

export function layerCannotImportRule(from: SrcLayer, to: SrcLayer): string {
  return `${from}-cannot-import-${to}`
}

export function isMainServicesPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/main/services/')
}

export function isMainAgentPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/main/agent/')
}

export function isMainIpcPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/main/ipc/')
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

export function isAgentLoopPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix) === 'src/runtime/agent/AgentLoop.ts'
}

export function isAgentCorePath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/runtime/agent/core/')
}

export function isRendererChatSlicePath(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    normalized.startsWith('src/renderer/stores/chat/slices/')
    && normalized !== 'src/renderer/stores/chat/slices/index.ts'
  )
}

export function isRendererChatSlicesPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/renderer/stores/chat/slices/')
}

export function isRendererChatInternalPath(repoRelativePosix: string): boolean {
  return toRepoPosixPath(repoRelativePosix).startsWith('src/renderer/stores/chat/internal/')
}

export function isRendererChatStoreRootPath(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    normalized === 'src/renderer/stores/useChatStore.ts'
    || normalized === 'src/renderer/stores/chat/index.ts'
    || normalized === 'src/renderer/stores/chat/createChatStore.ts'
  )
}

export function isAllowedRendererChatInternalDependency(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    isRendererChatInternalPath(normalized)
    || normalized === 'src/renderer/stores/chat/types.ts'
    || normalized === 'src/renderer/stores/chat/constants.ts'
    || normalized.startsWith('src/renderer/lib/')
  )
}

export function isRendererComponentPath(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    normalized === 'src/renderer/App.tsx'
    || normalized.startsWith('src/renderer/components/')
    || normalized.startsWith('src/renderer/features/')
  )
}

/** 产品执行器子树：AgentLoop 只能经 TurnDispatcher 间接使用，不得直接依赖 */
export function isProductExecutorPath(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    normalized.startsWith('src/runtime/skills/') ||
    normalized.startsWith('src/runtime/workflow/')
  )
}

/** 路由解析和产品执行器都属于 kernel 外的产品控制面。 */
export function isProductRoutingPath(repoRelativePosix: string): boolean {
  const normalized = toRepoPosixPath(repoRelativePosix)
  return (
    normalized.startsWith('src/runtime/agent/turn/')
    || isProductExecutorPath(normalized)
  )
}

export function violationKey(edge: Pick<BoundaryViolation, 'from' | 'to' | 'rule'>): string {
  return `${edge.from}\0${edge.to}\0${edge.rule}`
}

/**
 * 根据已解析的 from/to 文件边计算命中的规则（可能为空）。
 * 同层边检查 runtime/run → runtime/workflow、main/services → main/ipc、main/agent → main/ipc。
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
  if (isMainServicesPath(from) && isMainIpcPath(to)) {
    rules.push(RULE_MAIN_SERVICES_CANNOT_IMPORT_IPC)
  }
  if (isMainAgentPath(from) && isMainIpcPath(to)) {
    rules.push(RULE_MAIN_AGENT_CANNOT_IMPORT_IPC)
  }
  if (isAgentLoopPath(from) && isProductExecutorPath(to)) {
    rules.push(RULE_AGENT_LOOP_CANNOT_IMPORT_PRODUCT_EXECUTORS)
  }
  if (isAgentCorePath(from) && isProductRoutingPath(to)) {
    rules.push(RULE_AGENT_CORE_CANNOT_IMPORT_PRODUCT_ROUTING)
  }
  if (isRendererChatSlicePath(from) && isRendererChatStoreRootPath(to)) {
    rules.push(RULE_CHAT_SLICE_CANNOT_IMPORT_STORE_ROOT)
  }
  if (isRendererChatSlicePath(from) && isRendererChatSlicesPath(to)) {
    rules.push(RULE_CHAT_SLICES_CANNOT_IMPORT_EACH_OTHER)
  }
  if (isRendererChatSlicePath(from) && isRendererComponentPath(to)) {
    rules.push(RULE_CHAT_SLICE_CANNOT_IMPORT_RENDERER_UI)
  }
  if (
    isRendererChatSlicePath(from)
    && toRepoPosixPath(to) === 'src/renderer/stores/types.ts'
  ) {
    rules.push(RULE_CHAT_SLICE_CANNOT_IMPORT_LEGACY_STORE_TYPES)
  }
  if (isRendererChatInternalPath(from) && isRendererChatSlicesPath(to)) {
    rules.push(RULE_CHAT_INTERNAL_CANNOT_IMPORT_SLICES)
  }
  if (isRendererChatInternalPath(from) && isRendererChatStoreRootPath(to)) {
    rules.push(RULE_CHAT_INTERNAL_CANNOT_IMPORT_STORE_ROOT)
  }
  if (
    isRendererChatInternalPath(from)
    && layerOf(to) === 'renderer'
    && !isAllowedRendererChatInternalDependency(to)
    && !isRendererChatSlicesPath(to)
    && !isRendererChatStoreRootPath(to)
  ) {
    rules.push(RULE_CHAT_INTERNAL_CANNOT_IMPORT_RENDERER_IMPLEMENTATION)
  }
  if (
    isRendererComponentPath(from)
    && (isRendererChatInternalPath(to) || isRendererChatSlicesPath(to))
  ) {
    rules.push(RULE_COMPONENTS_CANNOT_IMPORT_CHAT_INTERNALS)
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

export function buildViolationsForExternalSpecifier(
  fromFile: string,
  specifier: string
): BoundaryViolation[] {
  const from = toRepoPosixPath(fromFile)
  const normalizedSpecifier = specifier.replace(/\\/g, '/')
  if (
    layerOf(from) === 'runtime'
    && (normalizedSpecifier === 'electron' || normalizedSpecifier.startsWith('electron/'))
  ) {
    return [{
      from,
      to: normalizedSpecifier,
      rule: RULE_RUNTIME_CANNOT_IMPORT_ELECTRON,
      specifier
    }]
  }
  return []
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
