/**
 * 会话树纯函数 — 由扁平节点 + currentLeafId 派生激活路径与分支元信息。
 *
 * 不依赖 Electron，供 SessionStore、上下文构建与单测复用。
 */
import type { SessionData, SessionMessage } from './types'

/** 分叉点 UI 元信息（主进程折叠 active path 时附加，与 shared/session BranchMeta 对齐） */
export interface BranchMeta {
  /** 当前节点在兄弟中的序号（1-based） */
  index: number
  /** 兄弟分支总数 */
  total: number
  /** 所有兄弟节点 id（含自身），按 timestamp 升序 */
  siblingIds: string[]
}

/**
 * 由扁平节点 + 当前叶子计算激活路径（时间正序：顶层祖先 → leaf）。
 * 从 leaf 沿 parentId 回溯；遇环或断链时停止并打 warn。
 */
export function computeActivePath(
  messages: SessionMessage[],
  currentLeafId: string | null
): SessionMessage[] {
  if (!currentLeafId || messages.length === 0) return []

  const byId = new Map(messages.map(m => [m.id, m]))
  const path: SessionMessage[] = []
  const seen = new Set<string>()
  let id: string | null = currentLeafId

  while (id !== null) {
    if (seen.has(id)) {
      console.warn(`[tree] computeActivePath: 检测到环，停止于 ${id}`)
      break
    }
    seen.add(id)

    const node = byId.get(id)
    if (!node) {
      console.warn(`[tree] computeActivePath: 找不到节点 ${id}，停止回溯`)
      break
    }

    path.push(node)
    id = node.parentId ?? null
  }

  path.reverse()
  return path
}

/** 激活路径上的消息条数（侧边栏 list 缓存的计算基准） */
export function computeMessageCount(
  messages: SessionMessage[],
  currentLeafId: string | null
): number {
  const leafId = resolveCurrentLeafId(messages, currentLeafId)
  return computeActivePath(messages, leafId).length
}

/** 构建 parentId → children[] 索引（children 按 timestamp 升序） */
export function buildChildrenIndex(
  messages: SessionMessage[]
): Map<string | null, SessionMessage[]> {
  const index = new Map<string | null, SessionMessage[]>()

  for (const msg of messages) {
    const parentId = msg.parentId ?? null
    const siblings = index.get(parentId) ?? []
    siblings.push(msg)
    index.set(parentId, siblings)
  }

  for (const children of index.values()) {
    children.sort((a, b) => a.timestamp - b.timestamp)
  }

  return index
}

/** 给定节点，返回它在其父的兄弟分支中的 (序号, 总数)，用于 UI 翻页器 */
export function getBranchPosition(
  messages: SessionMessage[],
  nodeId: string
): { index: number; total: number } {
  const byId = new Map(messages.map(m => [m.id, m]))
  const node = byId.get(nodeId)
  if (!node) return { index: 1, total: 1 }

  const parentId = node.parentId ?? null
  const siblings = buildChildrenIndex(messages).get(parentId) ?? [node]
  const idx = siblings.findIndex(s => s.id === nodeId)
  return { index: idx + 1, total: siblings.length }
}

/** 求两个叶子的最近公共祖先（LCA）节点 id */
export function findCommonAncestor(
  messages: SessionMessage[],
  leafA: string,
  leafB: string
): string | null {
  const pathAIds = new Set(computeActivePath(messages, leafA).map(m => m.id))
  const pathB = computeActivePath(messages, leafB)

  for (let i = pathB.length - 1; i >= 0; i--) {
    const id = pathB[i]!.id
    if (pathAIds.has(id)) return id
  }

  return null
}

/**
 * 在指定子树中找「最右」叶子（timestamp 最大的一条从该节点向下的路径末端）。
 * 用于分支翻页：切换到兄弟 user 消息后，currentLeaf 应落在该子树叶子。
 */
export function findSubtreeLeaf(
  messages: SessionMessage[],
  subtreeRootId: string
): string {
  const byId = new Map(messages.map(m => [m.id, m]))
  if (!byId.has(subtreeRootId)) return subtreeRootId

  const childrenIndex = buildChildrenIndex(messages)
  let currentId = subtreeRootId

  while (true) {
    const children = childrenIndex.get(currentId) ?? []
    if (children.length === 0) break
    // 取 timestamp 最大的子节点继续向下（与 append 时「最新分支」一致）
    const lastChild = children[children.length - 1]!
    currentId = lastChild.id
  }

  return currentId
}

/**
 * 校验并解析 currentLeafId。
 * - 显式 null：表示激活路径为空（下次 append 成森林新根），原样返回 null。
 * - undefined 或无效 id：回退到 messages 末条（与 v3 线性会话语义一致）。
 */
export function resolveCurrentLeafId(
  messages: SessionMessage[],
  currentLeafId: string | null | undefined
): string | null {
  if (messages.length === 0) return null
  // 显式 null 是「编辑首条消息后倒回起点」的合法状态，不能被回退覆盖
  if (currentLeafId === null) return null
  if (currentLeafId && messages.some(m => m.id === currentLeafId)) {
    return currentLeafId
  }
  if (currentLeafId) {
    console.warn(
      `[tree] resolveCurrentLeafId: currentLeafId=${currentLeafId} 不在会话中，回退到末条消息`
    )
  }
  return messages[messages.length - 1]!.id
}

/** 从 SessionData 取当前激活路径上的消息（时间正序） */
export function getSessionActiveMessages(session: SessionData): SessionMessage[] {
  const messages = ensureMessageParentChain(session.messages)
  const leafId = resolveCurrentLeafId(messages, session.currentLeafId)
  return computeActivePath(messages, leafId)
}

/**
 * 若消息缺少 parentId 字段，按数组顺序串成线性链（与 migrateV3ToV4 同构）。
 * 用于 load/save 兜底：旧测试或 rollback 直接 save 时未写 parentId 的场景。
 */
export function ensureMessageParentChain(messages: SessionMessage[]): SessionMessage[] {
  if (messages.length === 0) return []
  if (messages.every(m => m.parentId !== undefined)) return messages
  return messages.map((msg, i) => ({
    ...msg,
    parentId: i === 0 ? null : messages[i - 1]!.id
  }))
}

/** 为 active path 上存在兄弟的节点附加 BranchMeta（阶段 3 UI 用，阶段 1 先实现供单测） */
export function attachBranchMeta(
  activePath: SessionMessage[],
  allMessages: SessionMessage[]
): Array<SessionMessage & { branch?: BranchMeta }> {
  const childrenIndex = buildChildrenIndex(allMessages)

  return activePath.map(msg => {
    const parentId = msg.parentId ?? null
    const siblings = childrenIndex.get(parentId) ?? []
    if (siblings.length <= 1) return msg

    const siblingIds = siblings.map(s => s.id)
    const index = siblings.findIndex(s => s.id === msg.id) + 1
    return {
      ...msg,
      branch: { index, total: siblings.length, siblingIds }
    }
  })
}
