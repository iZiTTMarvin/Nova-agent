import type { CodeIndexSnapshot, CodeIndexStatus } from '../types'
import type { CodeGraphReader } from '../graph/queries/CodeGraphReader'
import {
  ContextPackBuilder,
  createEmptyCodeContextPack,
  type CodeContextPack,
  type CodeContextQueryPort,
  type CodeContextQueryRequest
} from './ContextPackBuilder'

export interface CodeGraphEngineOptions {
  readonly getSnapshot: () => CodeIndexSnapshot
  readonly getReader: () => Promise<CodeGraphReader | null>
}

/** 只读已提交快照并生成 Context Pack，不触发刷新或持久化。 */
export class CodeGraphEngine implements CodeContextQueryPort {
  constructor(private readonly options: CodeGraphEngineOptions) {}

  async query(request: CodeContextQueryRequest): Promise<CodeContextPack> {
    throwIfAborted(request.abortSignal)
    let snapshot = this.options.getSnapshot()
    if (request.intent === 'flow') {
      return createEmptyCodeContextPack({
        status: 'unavailable',
        revision: snapshot.revision,
        intent: 'flow',
        summary: 'unavailable · flow · 当前版本不提供多跳代码流；建议改用 impact 或 grep',
        coverage: snapshot.coverage,
        warnings: ['flow 当前不可用；请改用 impact，跨层通道可继续用 grep 定位']
      })
    }
    if (snapshot.activeGeneration === null) {
      return emptySnapshotPack(snapshot, request)
    }

    const reader = await this.options.getReader()
    throwIfAborted(request.abortSignal)
    if (reader === null) {
      return createEmptyCodeContextPack({
        status: 'unavailable',
        revision: snapshot.revision,
        intent: request.intent ?? 'locate',
        summary: 'unavailable · 代码索引读取端不可用',
        coverage: snapshot.coverage,
        warnings: ['代码索引读取端不可用；请改用 grep/read']
      })
    }

    snapshot = this.options.getSnapshot()
    const builder = new ContextPackBuilder({ reader })
    return builder.buildPack({
      ...request,
      status: queryStatus(snapshot)
    })
  }
}

function emptySnapshotPack(
  snapshot: CodeIndexSnapshot,
  request: CodeContextQueryRequest
): CodeContextPack {
  const status = queryStatus(snapshot)
  const intent = request.intent ?? 'locate'
  const reason = status === 'building'
    ? '代码索引正在首次构建；请继续使用 grep/read'
    : '代码索引当前不可用；请改用 grep/read'
  return createEmptyCodeContextPack({
    status,
    revision: snapshot.revision,
    intent,
    summary: `${status} · ${intent} · ${reason}`,
    coverage: snapshot.coverage,
    warnings: [reason]
  })
}

function queryStatus(snapshot: CodeIndexSnapshot): CodeIndexStatus {
  if (snapshot.activeGeneration === null) {
    return snapshot.status === 'unavailable' || snapshot.status === 'degraded'
      ? 'unavailable'
      : 'building'
  }
  return snapshot.status === 'idle' ? 'ready' : snapshot.status
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('代码上下文查询已取消')
  error.name = 'AbortError'
  throw error
}
