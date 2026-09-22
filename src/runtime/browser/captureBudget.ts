import {
  BROWSER_CAPTURE_MAX_BYTES,
  BROWSER_CAPTURE_MAX_PER_RUN
} from '../../shared/browser'

interface RunCaptureSpend {
  count: number
  bytes: number
}

const spendByOwner = new Map<string, RunCaptureSpend>()

export function captureBudgetOwnerId(resourceOwnerRunId: string | undefined, runId: string | undefined): string | null {
  const owner = resourceOwnerRunId?.trim() || runId?.trim()
  return owner && owner.length > 0 ? owner : null
}

export function inspectCaptureBudget(ownerId: string): RunCaptureSpend {
  return spendByOwner.get(ownerId) ?? { count: 0, bytes: 0 }
}

export function tryConsumeCaptureBudget(
  ownerId: string,
  encodedBytes: number
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const current = inspectCaptureBudget(ownerId)
  if (current.count >= BROWSER_CAPTURE_MAX_PER_RUN) {
    return {
      ok: false,
      detail: `本轮截图已达 ${BROWSER_CAPTURE_MAX_PER_RUN} 张上限`
    }
  }
  const nextBytes = current.bytes + encodedBytes
  const maxRunBytes = BROWSER_CAPTURE_MAX_PER_RUN * BROWSER_CAPTURE_MAX_BYTES
  if (nextBytes > maxRunBytes) {
    return {
      ok: false,
      detail: `本轮截图累计已超过 ${maxRunBytes} 字节上限`
    }
  }
  spendByOwner.set(ownerId, { count: current.count + 1, bytes: nextBytes })
  return { ok: true }
}

export function resetCaptureBudgetForTests(): void {
  spendByOwner.clear()
}
