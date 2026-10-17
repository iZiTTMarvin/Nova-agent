/**
 * 主进程可视化快照存储宿主：同一会话目录只有一个实例。
 * 原子写的临时文件由目标路径派生，同一快照的并发发布必须经同一实例合并（见 VisualizationStore）。
 */
import { resolve } from 'path'
import { VisualizationStore } from '../../runtime/visualizations/VisualizationStore'

const stores = new Map<string, VisualizationStore>()

export function getVisualizationStoreFor(sessionsDir: string): VisualizationStore {
  const key = resolve(sessionsDir)
  let store = stores.get(key)
  if (!store) {
    store = new VisualizationStore(key)
    stores.set(key, store)
  }
  return store
}
