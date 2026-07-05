/**
 * 记忆模块公共出口：仅导出端口类型与纯逻辑，不 re-export 原生实现。
 * 主进程请直接 import `@runtime/memory/BetterSqliteMemoryDb`。
 */

export type { MemoryDb, MemoryDbStatement } from './MemoryDb'
export { verifyTrigramFts5 } from './spikeVerify'
export type { TrigramSpikeResult } from './spikeVerify'
