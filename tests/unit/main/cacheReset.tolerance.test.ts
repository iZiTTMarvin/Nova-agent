/**
 * resetChromiumDiskCaches 的失败容忍：单个缓存目录删除失败不阻断其余目录与启动。
 * libuv 以 FILE_SHARE_DELETE 打开文件，进程内无法制造真实占用锁，这里直接让
 * rmSync 对名为 Cache 的路径抛错来覆盖 catch 分支。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    rmSync: (target: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (basename(String(target)) === 'Cache') {
        throw new Error('EPERM: operation not permitted (mock)')
      }
      return actual.rmSync(target, options)
    }
  }
})

import { resetChromiumDiskCaches } from '../../../src/main/cacheReset'

describe('resetChromiumDiskCaches 失败容忍', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'nova-cache-reset-tolerance-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('Cache 删除失败时记录日志，仍清理 GPUCache 且不抛出', () => {
    mkdirSync(join(sandbox, 'Cache'), { recursive: true })
    mkdirSync(join(sandbox, 'GPUCache'), { recursive: true })

    const messages: string[] = []
    expect(() => resetChromiumDiskCaches(sandbox, msg => messages.push(msg))).not.toThrow()

    expect(messages.some(m => m.includes('Cache'))).toBe(true)
    expect(existsSync(join(sandbox, 'GPUCache'))).toBe(false)
  })
})
