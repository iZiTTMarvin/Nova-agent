/**
 * 任务拓扑排序（Kahn）：按依赖拆成可并行批次。
 * 无环时返回批次数组；有环时把剩余节点作为最后一批（不抛错，避免卡死脚本）。
 */

export interface TopoTask {
  id: string
  /** 依赖的任务 id */
  deps?: string[]
  [key: string]: unknown
}

/**
 * Kahn 算法：入度为 0 的节点同一批可并行。
 * @returns 批次列表，每批内任务无相互依赖
 */
export function topoSort<T extends TopoTask>(tasks: T[]): T[][] {
  if (!tasks.length) return []

  const byId = new Map<string, T>()
  for (const t of tasks) byId.set(t.id, t)

  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const t of tasks) {
    indegree.set(t.id, 0)
    dependents.set(t.id, [])
  }

  for (const t of tasks) {
    const deps = (t.deps ?? []).filter((d) => byId.has(d))
    indegree.set(t.id, deps.length)
    for (const d of deps) {
      const list = dependents.get(d) ?? []
      list.push(t.id)
      dependents.set(d, list)
    }
  }

  const batches: T[][] = []
  let remaining = new Set(tasks.map((t) => t.id))

  while (remaining.size > 0) {
    const batchIds = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0)
    if (batchIds.length === 0) {
      // 环：剩余节点整批吐出，避免死循环
      const cycleBatch = [...remaining].map((id) => byId.get(id)!).filter(Boolean)
      if (cycleBatch.length) batches.push(cycleBatch)
      break
    }
    const batch = batchIds.map((id) => byId.get(id)!).filter(Boolean)
    batches.push(batch)
    for (const id of batchIds) {
      remaining.delete(id)
      for (const dep of dependents.get(id) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 1) - 1)
      }
    }
  }

  return batches
}
