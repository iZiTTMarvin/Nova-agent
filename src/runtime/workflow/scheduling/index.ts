/**
 * 结构化并发：任务作用域、并发信号量、依赖拓扑排序。
 *
 * 本层不依赖 workflow 下任何其他模块，只提供调度原语。
 */
export { TaskScope, withTaskScope } from './TaskScope'
export {
  makeSemaphore,
  makeRunSemaphore,
  getGlobalSemaphore,
  defaultGlobalMax
} from './semaphore'
export type { Semaphore } from './semaphore'
export { topoSort } from './topo'
export type { TopoTask } from './topo'
