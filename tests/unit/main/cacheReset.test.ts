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
import {
  resetChromiumDiskCaches,
  markChromiumCachesClean,
  clearChromiumCachesCleanMarker,
  CLEAN_SHUTDOWN_MARKER_FILE
} from '../../../src/main/cacheReset'

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

  it('打包态干净退出标记存在时跳过重建并消费标记', () => {
    mkdirSync(join(sandbox, 'Cache'), { recursive: true })
    writeFileSync(join(sandbox, CLEAN_SHUTDOWN_MARKER_FILE), '1')

    resetChromiumDiskCaches(sandbox, { packaged: true })

    expect(existsSync(join(sandbox, 'Cache'))).toBe(true)
    expect(existsSync(join(sandbox, CLEAN_SHUTDOWN_MARKER_FILE))).toBe(false)
  })

  it('打包态无标记（上次异常退出）时照常重建', () => {
    mkdirSync(join(sandbox, 'Cache'), { recursive: true })

    resetChromiumDiskCaches(sandbox, { packaged: true })

    expect(existsSync(join(sandbox, 'Cache'))).toBe(false)
  })

  it('markChromiumCachesClean 写入标记供下次启动识别', () => {
    markChromiumCachesClean(sandbox)
    expect(existsSync(join(sandbox, CLEAN_SHUTDOWN_MARKER_FILE))).toBe(true)
  })

  it('clearChromiumCachesCleanMarker 作废标记，下次启动回退重建', () => {
    markChromiumCachesClean(sandbox)
    mkdirSync(join(sandbox, 'Cache'), { recursive: true })

    clearChromiumCachesCleanMarker(sandbox)
    resetChromiumDiskCaches(sandbox, { packaged: true })

    expect(existsSync(join(sandbox, 'Cache'))).toBe(false)
  })
})
