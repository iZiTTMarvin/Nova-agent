import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetChromiumDiskCaches } from '../../../src/main/cacheReset'

describe('resetChromiumDiskCaches', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'nova-cache-reset-'))
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('删除全部 Chromium 缓存目录，不触碰其他 userData 内容', () => {
    for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
      mkdirSync(join(sandbox, dir), { recursive: true })
      writeFileSync(join(sandbox, dir, 'index'), 'stale')
    }
    mkdirSync(join(sandbox, 'sessions'))
    writeFileSync(join(sandbox, 'sessions', 'keep.json'), '{}')

    resetChromiumDiskCaches(sandbox)

    expect(readdirSync(sandbox)).toEqual(['sessions'])
    expect(existsSync(join(sandbox, 'sessions', 'keep.json'))).toBe(true)
  })

  it('缓存目录不存在时静默通过', () => {
    expect(() => resetChromiumDiskCaches(sandbox)).not.toThrow()
  })
})
