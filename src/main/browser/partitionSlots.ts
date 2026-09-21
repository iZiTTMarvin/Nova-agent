/**
 * 两个惰性临时 partition 槽。复用前必须清理成功，失败则永久不把旧资料带给新页。
 */
export const BROWSER_PARTITION_SLOT_COUNT = 2 as const

export const BROWSER_PARTITION_SLOT_NAMES = [
  'persist:nova-browser-slot-0',
  'persist:nova-browser-slot-1'
] as const

export type BrowserPartitionSlotState = 'idle' | 'busy' | 'unusable'

export interface BrowserPartitionSlot {
  readonly index: 0 | 1
  readonly partition: (typeof BROWSER_PARTITION_SLOT_NAMES)[number]
  readonly state: BrowserPartitionSlotState
  readonly ownerBrowserId: string | null
}

export interface PartitionCleanup {
  (partition: string): Promise<void>
}

export interface BrowserPartitionSlotPool {
  acquire(browserId: string):
    | { readonly ok: true; readonly partition: string; readonly index: 0 | 1 }
    | { readonly ok: false; readonly code: 'resource_limit' }
  release(browserId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly unusable: true }>
  inspect(): readonly BrowserPartitionSlot[]
}

interface SlotRecord {
  index: 0 | 1
  partition: (typeof BROWSER_PARTITION_SLOT_NAMES)[number]
  state: BrowserPartitionSlotState
  ownerBrowserId: string | null
}

export function createBrowserPartitionSlotPool(cleanup: PartitionCleanup): BrowserPartitionSlotPool {
  const slots: SlotRecord[] = BROWSER_PARTITION_SLOT_NAMES.map((partition, index) => ({
    index: index as 0 | 1,
    partition,
    state: 'idle',
    ownerBrowserId: null
  }))

  function snapshot(): BrowserPartitionSlot[] {
    return slots.map((slot) => ({
      index: slot.index,
      partition: slot.partition,
      state: slot.state,
      ownerBrowserId: slot.ownerBrowserId
    }))
  }

  return {
    acquire(browserId) {
      if (slots.some((slot) => slot.ownerBrowserId === browserId && slot.state === 'busy')) {
        const owned = slots.find((slot) => slot.ownerBrowserId === browserId)
        if (!owned) return { ok: false, code: 'resource_limit' }
        return { ok: true, partition: owned.partition, index: owned.index }
      }
      const free = slots.find((slot) => slot.state === 'idle')
      if (!free) return { ok: false, code: 'resource_limit' }
      free.state = 'busy'
      free.ownerBrowserId = browserId
      return { ok: true, partition: free.partition, index: free.index }
    },

    async release(browserId) {
      const slot = slots.find((item) => item.ownerBrowserId === browserId)
      if (!slot) return { ok: true }
      if (slot.state === 'unusable') {
        slot.ownerBrowserId = null
        return { ok: false, unusable: true }
      }
      try {
        await cleanup(slot.partition)
        slot.state = 'idle'
        slot.ownerBrowserId = null
        return { ok: true }
      } catch {
        slot.state = 'unusable'
        slot.ownerBrowserId = null
        return { ok: false, unusable: true }
      }
    },

    inspect: () => snapshot()
  }
}
