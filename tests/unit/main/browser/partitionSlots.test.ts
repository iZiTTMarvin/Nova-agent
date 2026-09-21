import { describe, expect, it } from 'vitest'
import {
  BROWSER_PARTITION_SLOT_COUNT,
  BROWSER_PARTITION_SLOT_NAMES,
  createBrowserPartitionSlotPool
} from '../../../../src/main/browser/partitionSlots'

describe('隔离 partition 槽', () => {
  it('只有两个惰性槽，复用前会清理', async () => {
    const cleaned: string[] = []
    const pool = createBrowserPartitionSlotPool(async (partition) => {
      cleaned.push(partition)
    })
    expect(pool.inspect()).toHaveLength(BROWSER_PARTITION_SLOT_COUNT)
    expect(pool.inspect().every((slot) => slot.state === 'idle')).toBe(true)

    const first = pool.acquire('brw_1')
    const second = pool.acquire('brw_2')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.partition).toBe(BROWSER_PARTITION_SLOT_NAMES[0])
    expect(second.partition).toBe(BROWSER_PARTITION_SLOT_NAMES[1])
    expect(pool.acquire('brw_3')).toEqual({ ok: false, code: 'resource_limit' })

    expect(await pool.release('brw_1')).toEqual({ ok: true })
    expect(cleaned).toEqual([BROWSER_PARTITION_SLOT_NAMES[0]])
    const reused = pool.acquire('brw_4')
    expect(reused).toEqual({
      ok: true,
      partition: BROWSER_PARTITION_SLOT_NAMES[0],
      index: 0
    })
    expect(pool.inspect()[0]?.ownerBrowserId).toBe('brw_4')
  })

  it('清理失败的槽进入不可用，不再发给新页面', async () => {
    const pool = createBrowserPartitionSlotPool(async () => {
      throw new Error('clearStorageData failed')
    })
    expect(pool.acquire('brw_1').ok).toBe(true)
    expect(await pool.release('brw_1')).toEqual({ ok: false, unusable: true })
    expect(pool.inspect()[0]?.state).toBe('unusable')

    const next = pool.acquire('brw_2')
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.partition).toBe(BROWSER_PARTITION_SLOT_NAMES[1])
    expect(pool.acquire('brw_3')).toEqual({ ok: false, code: 'resource_limit' })
  })
})
