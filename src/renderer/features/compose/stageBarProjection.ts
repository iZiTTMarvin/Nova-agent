/**
 * 阶段条投影纯函数（测试 seam）
 *
 * 把持久化阶段表投影成六个固定节点的渲染 props：
 * - stages 为 null/undefined（新会话/旧会话）时按初始表投影，纯显示不落盘
 * - 防御性按 COMPOSE_STAGE_IDS 顺序对齐，缺失阶段补 pending，保证恒为六节点
 * - 回退目标列表与 applyStageTransition 的校验口径一致：当前游标之前的阶段
 */
import {
  COMPOSE_STAGE_IDS,
  COMPOSE_STAGE_LABELS,
  createInitialStageTable,
  getComposeStageCursor,
  type ComposeStageEntry,
  type ComposeStageId,
  type ComposeStageStatus
} from '../../../shared/composeLifecycle'

export interface StageNodeProjection {
  id: ComposeStageId
  label: string
  status: ComposeStageStatus
  /** 跳过/回退原因 */
  note?: string
  completedAt?: number
  isCurrent: boolean
  /** 仅「开发」节点：会话 todo 的聚合进度，驱动 `开发 ● 3/5` 标签与可展开明细 */
  progress?: { completed: number; total: number }
}

export interface StageReturnTarget {
  id: ComposeStageId
  label: string
}

export interface StageBarProjection {
  nodes: StageNodeProjection[]
  currentStageId: ComposeStageId | null
  /** 全部阶段 completed/skipped、无 in_progress：生命周期已走完 */
  isTerminal: boolean
  /** 可回退目标（当前游标之前的阶段；终态时游标视为末尾之后，均可回退） */
  returnTargets: StageReturnTarget[]
}

export function projectStageBar(
  stages: ComposeStageEntry[] | null | undefined,
  implementProgress?: { completed: number; total: number }
): StageBarProjection {
  const source = stages ?? createInitialStageTable()
  const byId = new Map(source.map((entry) => [entry.id, entry]))

  const nodes: StageNodeProjection[] = COMPOSE_STAGE_IDS.map((id) => {
    const entry = byId.get(id)
    const node: StageNodeProjection = {
      id,
      label: COMPOSE_STAGE_LABELS[id],
      status: entry?.status ?? 'pending',
      isCurrent: entry?.status === 'in_progress'
    }
    if (entry?.note !== undefined) node.note = entry.note
    if (entry?.completedAt !== undefined) node.completedAt = entry.completedAt
    if (id === 'implement' && implementProgress) node.progress = implementProgress
    return node
  })

  // 游标语义（当前阶段 / 终态 / 可回退范围）与转换校验共用同一份推导
  const cursor = getComposeStageCursor(nodes)
  const returnTargets: StageReturnTarget[] = nodes
    .slice(0, cursor.returnCursor)
    .map((node) => ({ id: node.id, label: node.label }))

  return {
    nodes,
    currentStageId: cursor.currentStageId,
    isTerminal: cursor.isTerminal,
    returnTargets
  }
}

/** 阶段条挂载门控：仅 compose 模式主会话；子代理会话与 default/plan 会话不显示 */
export function shouldShowComposeStageBar(
  session: { mode: string; kind: string } | null | undefined
): boolean {
  return !!session && session.mode === 'compose' && session.kind !== 'subagent'
}
