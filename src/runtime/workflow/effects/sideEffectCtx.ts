/** 副作用凭证所需的最小、显式上下文。 */
export interface SideEffectCtx {
  runId: string
  stepId: string
  idempotencyKey: string
}

/** 将幂等键转换为安全、稳定的凭证文件名。 */
export function effectIdFromKey(idempotencyKey: string): string {
  return idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}
