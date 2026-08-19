/**
 * 会话级工具可用性 Owner：Tool Economy 三态（off / shadow / on）下的激活态、
 * 投影与执行闸门。工具是否属于 deferred 组由 Tool Catalog 决定，本类只拥有激活状态。
 *
 * - off：恒等投影（隐藏 load_tools），与历史行为字节级一致。
 * - shadow：模型仍收到全量工具面，仅旁路计算 would-be 激活集与诊断，不改 wire。
 * - on：core + 已激活 live 组 + required pin 进入模型可见面；未激活 deferred 工具
 *   既不可见也不可执行（gating 在工具批次执行前快照判定，天然拒绝同 step 激活+调用）。
 */
import type { ToolDefinition } from '../../model/types'
import {
  getToolGroup,
  isLoadableToolGroup,
  isKnownToolGroup,
  listLiveDeferredGroupIds,
  normalizeGroupAlias
} from '../catalog'

export type ToolEconomyMode = 'off' | 'shadow' | 'on'

/** 激活来源：模型主动 load_tools / Harness required pin / 会话恢复 */
export type ToolActivationReason = 'model' | 'required' | 'restored'

/** load_tools 成功结果中的稳定标记，供旧消息历史回填恢复 */
export const LOAD_TOOLS_ACTIVATED_MARKER = 'tool_group_activated:'

/** 会话持久化形状（与 SessionData.toolAvailability 字段对齐） */
export interface ToolAvailabilityPersistState {
  readonly version: 1
  readonly activatedGroups: readonly string[]
}

/** 消息扫描回填的最小结构输入（ChatMessage / SessionMessage 均结构兼容） */
export interface ToolGroupMarkerMessage {
  readonly role: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string
    readonly name: string
    readonly arguments: string
  }>
  readonly toolCallId?: string
  readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: unknown }>
}

export interface ToolEconomyActivationRecord {
  readonly group: string
  readonly reason: ToolActivationReason
  readonly at: number
}

export interface ToolAvailabilityDiagnostics {
  readonly mode: ToolEconomyMode
  readonly visibleToolCount: number
  readonly fullToolCount: number
  readonly hiddenToolCount: number
  readonly visibleToolSchemaChars: number
  readonly fullToolSchemaChars: number
  readonly toolSchemaCharReduction: number
  readonly estimatedToolSchemaTokenReduction: number
  readonly activeGroups: readonly string[]
  readonly availableGroups: readonly string[]
  readonly activations: readonly ToolEconomyActivationRecord[]
  readonly loadToolsCallCount: number
  /** 激活后从未有成员通过执行闸门的组数（发现模型误判能力组） */
  readonly unusedActivationCount: number
  /** shadow 专有：当前未激活、但 economy=on 时会被隐藏的已注册 deferred 工具 */
  readonly wouldHideTools: readonly string[]
  /** shadow 专有：未激活却实际被调用的 deferred 工具（若 economy=on 将缺失） */
  readonly wouldMissTools: readonly string[]
}

const SCHEMA_TOKEN_CHARS = 4

export class ToolAvailability {
  private economyMode: ToolEconomyMode = 'off'
  private readonly activatedGroups = new Set<string>()
  private requiredToolNames: ReadonlySet<string> = new Set()
  /** 装配期绑定的注册清单只读投影，用于判定 live deferred 组 */
  private registeredToolNames: ReadonlySet<string> = new Set()
  /** 已从会话持久态或消息回填初始化，后续消息扫描不再重建状态 */
  private durableRestored = false
  private readonly activations: ToolEconomyActivationRecord[] = []
  /** 通过执行闸门的 deferred 工具观察集（使用率 / unused activation 判定） */
  private readonly observedDeferredToolCalls = new Set<string>()
  private loadToolsCallCount = 0
  private persistCallback: ((state: ToolAvailabilityPersistState) => void) | null = null

  setEconomyMode(mode: ToolEconomyMode): void {
    this.economyMode = mode
  }

  getEconomyMode(): ToolEconomyMode {
    return this.economyMode
  }

  /** 绑定注册清单（装配期一次）；可用性判定全部以此为只读投影 */
  bindRegisteredToolNames(names: Iterable<string>): void {
    this.registeredToolNames = new Set(names)
  }

  /**
   * Harness 确定某工具本轮必需时直接 pin：进入 active set，无需 load_tools 往返。
   * 当前 turn 生效，仍需经过 Permission。
   */
  setRequiredToolNames(names: Iterable<string>): void {
    this.requiredToolNames = new Set(names)
  }

  getActivatedGroups(): ReadonlySet<string> {
    return this.activatedGroups
  }

  setPersistCallback(cb: ((state: ToolAvailabilityPersistState) => void) | null): void {
    this.persistCallback = cb
  }

  /** 当前 live deferred 组（Catalog ∩ 注册清单，稳定顺序） */
  getAvailableGroups(): readonly string[] {
    return listLiveDeferredGroupIds(this.registeredToolNames)
  }

  /** economy=on 时模型实际可见的工具名集合（core ∪ 激活组成员 ∪ required pin） */
  getActiveToolNames(): readonly string[] {
    if (this.economyMode !== 'on') {
      return [...this.registeredToolNames].filter(name => name !== 'load_tools').sort()
    }
    return [...this.computeOnActiveToolNames()].sort()
  }

  /**
   * 激活组；下一轮 filterDefinitions / 执行闸门读取即生效。
   * 同一工具批次内的激活与调用无法互相解锁：批次闸门在执行前统一快照。
   */
  activate(
    group: string,
    reason: ToolActivationReason = 'model'
  ): { ok: true; group: string; alreadyActive: boolean } | { ok: false; error: string } {
    const normalized = normalizeGroupAlias(group)
    if (this.economyMode !== 'on') {
      return { ok: false, error: '工具经济未启用（off/shadow），无法激活工具组' }
    }
    if (!isKnownToolGroup(normalized)) {
      return {
        ok: false,
        error: `未知工具组 "${group}"。可加载组: ${this.getAvailableGroups().join(', ')}`
      }
    }
    if (!isLoadableToolGroup(normalized)) {
      return { ok: false, error: `工具组 "${normalized}" 为预留组，暂无可加载工具` }
    }
    if (!this.getAvailableGroups().includes(normalized)) {
      return {
        ok: false,
        error: `工具组 "${normalized}" 当前没有已注册的工具。可加载组: ${this.getAvailableGroups().join(', ')}`
      }
    }

    const alreadyActive = this.activatedGroups.has(normalized)
    if (!alreadyActive) {
      this.activatedGroups.add(normalized)
      this.activations.push({ group: normalized, reason, at: Date.now() })
      this.persistActivatedGroups()
    }
    if (reason === 'model') {
      this.loadToolsCallCount++
    }
    return { ok: true, group: normalized, alreadyActive }
  }

  /** 执行闸门：deferred 工具必须 active（激活或 required pin）才可执行 */
  isToolAvailable(toolName: string): boolean {
    const group = getToolGroup(toolName)
    if (group !== null) {
      this.observedDeferredToolCalls.add(toolName)
    }
    if (this.economyMode !== 'on' || group === null) {
      return true
    }
    return this.isToolActive(toolName)
  }

  /**
   * 模型可见面投影（mode 过滤之后调用）。
   * off/shadow 返回全量面（隐藏 load_tools 连接器），与历史 wire 一致；
   * on 返回 core + 激活组成员 + required pin + 连接器（存在 live 组时），按名称稳定排序。
   */
  filterDefinitions<T extends { name: string }>(definitions: readonly T[]): T[] {
    if (this.economyMode !== 'on') {
      return definitions.filter(def => def.name !== 'load_tools')
    }
    const liveGroups = listLiveDeferredGroupIds(this.registeredToolNames)
    return definitions
      .filter(def => {
        if (def.name === 'load_tools') return liveGroups.length > 0
        return this.isToolActive(def.name)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 从会话持久化状态恢复（权威路径）。
   * 未知版本 / 损坏字段 → usable=false 且不占位 durable 态，由调用方回退消息回填并修复落盘。
   * 已删除的组（历史 web / memory）与预留空组安全忽略，不因历史状态重新出现。
   */
  restoreFromSessionState(raw: unknown): { restoredGroups: readonly string[]; usable: boolean } {
    const parsed = parsePersistState(raw)
    this.activatedGroups.clear()
    if (!parsed) {
      return { restoredGroups: [], usable: false }
    }
    for (const group of parsed.activatedGroups) {
      const normalized = normalizeGroupAlias(group)
      if (!isLoadableToolGroup(normalized)) continue
      if (this.activatedGroups.has(normalized)) continue
      this.activatedGroups.add(normalized)
      this.activations.push({ group: normalized, reason: 'restored', at: Date.now() })
    }
    this.durableRestored = true
    return { restoredGroups: [...this.activatedGroups].sort(), usable: true }
  }

  /**
   * 旧消息 marker 兼容回填：仅在尚未从持久态恢复时扫描一次。
   * 扫描 assistant.load_tools 调用，且仅在存在配对成功标记的 tool 结果时计入。
   */
  backfillFromMessages(messages: readonly ToolGroupMarkerMessage[]): {
    restoredGroups: readonly string[]
  } {
    if (this.durableRestored) {
      return { restoredGroups: [...this.activatedGroups].sort() }
    }
    this.activatedGroups.clear()
    const pendingById = new Map<string, string>()

    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) {
          if (call.name !== 'load_tools') continue
          const group = parseLoadToolsGroupArg(call.arguments)
          if (!group) continue
          if (call.id) {
            pendingById.set(call.id, group)
          }
          // 无 toolCallId 时无法配对结果，跳过
        }
      }

      if (message.role === 'tool' && message.toolCallId) {
        const group = pendingById.get(message.toolCallId)
        if (!group) continue
        pendingById.delete(message.toolCallId)
        const normalized = normalizeGroupAlias(group)
        if (messageText(message.content).includes(`${LOAD_TOOLS_ACTIVATED_MARKER}${group}`)) {
          if (isLoadableToolGroup(normalized) && !this.activatedGroups.has(normalized)) {
            this.activatedGroups.add(normalized)
            this.activations.push({ group: normalized, reason: 'restored', at: Date.now() })
          }
        }
      }
    }

    // 无配对结果的调用：保守起见不激活（避免失败调用污染状态）
    this.durableRestored = true
    return { restoredGroups: [...this.activatedGroups].sort() }
  }

  /** 会话级持久化快照；无激活组时返回 null（调用方省略字段） */
  getPersistableState(): ToolAvailabilityPersistState | null {
    if (this.activatedGroups.size === 0) return null
    return { version: 1, activatedGroups: [...this.activatedGroups].sort() }
  }

  /** load_tools 连接器描述由 Catalog + 注册清单派生（见 catalog.buildLoadToolsDescription） */

  /**
   * 诊断快照。入参应为注册表全量定义（不含 mode 过滤）——本口径度量
   * availability 单独造成的收缩；visible 按当前模式投影，would-be 指标
   * 按 economy=on 语义计算（shadow 评估用）。
   */
  getDiagnostics(fullDefinitions: readonly ToolDefinition[]): ToolAvailabilityDiagnostics {
    const visible = this.filterDefinitions(fullDefinitions)
    const visibleChars = sumSchemaChars(visible)
    const fullChars = sumSchemaChars(fullDefinitions)
    const charReduction = Math.max(0, fullChars - visibleChars)

    const liveGroups = this.getAvailableGroups()
    const deferredRegistered = [...this.registeredToolNames].filter(
      name => getToolGroup(name) !== null
    )
    // would-be active set：若 economy=on，当前激活/required 状态下应可见的集合
    const activeToolNames = new Set(this.computeOnActiveToolNames())
    const wouldHideTools = deferredRegistered.filter(name => !activeToolNames.has(name))
    const wouldMissTools = [...this.observedDeferredToolCalls].filter(
      name => !activeToolNames.has(name)
    )
    const unusedGroups = [...this.activatedGroups].filter(group =>
      deferredRegistered.every(name => getToolGroup(name) !== group ||
        !this.observedDeferredToolCalls.has(name))
    )

    return {
      mode: this.economyMode,
      visibleToolCount: visible.length,
      fullToolCount: fullDefinitions.length,
      hiddenToolCount: Math.max(0, fullDefinitions.length - visible.length),
      visibleToolSchemaChars: visibleChars,
      fullToolSchemaChars: fullChars,
      toolSchemaCharReduction: charReduction,
      estimatedToolSchemaTokenReduction: Math.ceil(charReduction / SCHEMA_TOKEN_CHARS),
      activeGroups: [...this.activatedGroups].sort(),
      availableGroups: [...liveGroups],
      activations: [...this.activations],
      loadToolsCallCount: this.loadToolsCallCount,
      unusedActivationCount: this.economyMode === 'on' ? unusedGroups.length : 0,
      wouldHideTools,
      wouldMissTools
    }
  }

  private isToolActive(toolName: string): boolean {
    if (toolName === 'load_tools') return true
    const group = getToolGroup(toolName)
    if (group === null) return true
    return this.requiredToolNames.has(toolName) || this.activatedGroups.has(group)
  }

  /** economy=on 语义下的可见工具名集合（与当前模式无关，shadow 评估复用） */
  private computeOnActiveToolNames(): readonly string[] {
    return [...this.registeredToolNames].filter(name => this.isToolActive(name))
  }

  private persistActivatedGroups(): void {
    const state = this.getPersistableState()
    if (!state) return
    try {
      this.persistCallback?.(state)
    } catch {
      // 持久化失败不阻断激活；下一轮装配会从消息回填兜底恢复
    }
  }
}

function parsePersistState(raw: unknown): ToolAvailabilityPersistState | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as { version?: unknown; activatedGroups?: unknown }
  if (obj.version !== 1) return null
  if (!Array.isArray(obj.activatedGroups)) return null
  const groups: string[] = []
  for (const item of obj.activatedGroups) {
    if (typeof item !== 'string' || !item.trim()) continue
    groups.push(item)
  }
  return { version: 1, activatedGroups: groups }
}

function parseLoadToolsGroupArg(argumentsJson: string): string | null {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const group = (parsed as { group?: unknown }).group
    return typeof group === 'string' && group.trim() ? group.trim() : null
  } catch {
    return null
  }
}

function messageText(content: ToolGroupMarkerMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

function sumSchemaChars(definitions: readonly { name: string; description?: string; parameters?: unknown }[]): number {
  let total = 0
  for (const def of definitions) {
    total += JSON.stringify({
      name: def.name,
      description: def.description ?? '',
      parameters: def.parameters ?? null
    }).length
  }
  return total
}

/** 开发诊断日志行（load_tools 执行 / 会话恢复共用同一格式） */
export function formatToolEconomyActivationLog(record: {
  group: string
  reason: ToolActivationReason
  previousActive: number
  nextActive: number
  outcome: 'success' | 'already_loaded'
}): string {
  return [
    '[tool-economy]',
    `group=${record.group}`,
    `activation=${record.outcome}`,
    `previousActive=${record.previousActive}`,
    `nextActive=${record.nextActive}`,
    `reason=${record.reason}`
  ].join(' ')
}
