import type { MemoryIndex } from '../index/MemoryIndex'
import type { MemoryEntryStore } from '../markdown/MemoryEntryStore'
import type { ForgottenMemory, MemoryScope } from '../types'

/**
 * 一份持有被遗忘内容副本的派生存储（会话快照、迁移备份等）。
 * redact 失败即抛出，副本清理必须先于事实源删除完成。
 */
export interface MemoryForgetCopy {
  readonly label: string
  redact(forgotten: ForgottenMemory): void
}

/**
 * 彻底遗忘的唯一编排入口。
 * 顺序按隐私安全设计：先清派生副本，再删事实源，最后清索引残留。
 * 全程同步：派生副本清理与删除事实源之间不能插入新的 turn，
 * 否则新 turn 捕获的会话快照会带着被遗忘内容再次落盘。
 */
export class MemoryForgetter {
  constructor(
    private readonly deps: {
      store: MemoryEntryStore
      copies: readonly MemoryForgetCopy[]
      index: Pick<MemoryIndex, 'purgeResidue'> | null
    }
  ) {}

  forget(scope: MemoryScope, id: string): boolean {
    const { store, copies, index } = this.deps
    if (store.isReadOnly()) throw new Error('Memory files are read-only')
    const forgotten = store.collectForgetTargets(scope, id)
    if (!forgotten) return false
    for (const copy of copies) {
      try { copy.redact(forgotten) }
      catch (error) { throw new Error(`遗忘未完成：${copy.label}清理失败，记忆仍保留，可重试`, { cause: error }) }
    }
    if (!store.purge(scope, id)) throw new Error('遗忘失败')
    try { index?.purgeResidue() }
    catch (error) { throw new Error('记忆已删除，但索引残留清理失败，将在下次启动时重试', { cause: error }) }
    return true
  }
}
