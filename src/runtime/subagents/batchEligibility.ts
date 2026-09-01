import { resolveSubagentProfileSnapshot } from './profileResolver'

/**
 * 批次只读资格：在任何 child 创建前基于权威 catalog/profile snapshot 判断
 * effective ceiling 是否为 read_only。general-purpose、code 等含写/shell 的 profile
 * 均拒绝；单项 model override 不改变该判断。
 */

export interface BatchEligibilityInput {
  readonly profileId: string
  readonly rawProfile: unknown
}

export class BatchReadonlyEligibilityError extends Error {
  readonly name = 'BatchReadonlyEligibilityError'
  constructor(readonly profileId: string, message: string) {
    super(message)
  }
}

export function assertBatchItemReadonlyEligibility(input: BatchEligibilityInput): void {
  let snapshot: ReturnType<typeof resolveSubagentProfileSnapshot>
  try {
    snapshot = resolveSubagentProfileSnapshot(input.rawProfile, input.profileId)
  } catch (error) {
    throw new BatchReadonlyEligibilityError(input.profileId, error instanceof Error ? error.message : String(error))
  }
  if (snapshot.permissionCeiling !== 'read_only') {
    throw new BatchReadonlyEligibilityError(input.profileId, `批次只允许只读 profile，${input.profileId} 的 effective ceiling 为 ${snapshot.permissionCeiling}`)
  }
}

export function assertBatchInputReadonlyEligibility(items: readonly BatchEligibilityInput[]): void {
  for (const item of items) {
    assertBatchItemReadonlyEligibility(item)
  }
}
