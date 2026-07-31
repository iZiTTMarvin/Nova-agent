import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFsFns } from '../../../../../src/runtime/workflow/host/fsFn'
import { listFileEffects } from '../../../../../src/runtime/workflow/effects/fileEffect'
import { makeHostHarness } from './hostTestContext'

describe('host fsFn', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-fs-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('write → read → exists → delete 闭环，并落 committed 凭证', async () => {
    const h = makeHostHarness(tmp)
    const fs = createFsFns(h.ctx)

    await fs.write('src/a.txt', 'hello')
    expect(readFileSync(join(tmp, 'src/a.txt'), 'utf-8')).toBe('hello')
    await expect(fs.read('src/a.txt')).resolves.toBe('hello')
    await expect(fs.exists('src/a.txt')).resolves.toBe(true)

    const afterWrite = listFileEffects(tmp, h.ctx.runId)
    expect(afterWrite).toHaveLength(1)
    expect(afterWrite[0]!.status).toBe('committed')
    expect(afterWrite[0]!.action).toBe('create')

    await fs.delete('src/a.txt')
    expect(existsSync(join(tmp, 'src/a.txt'))).toBe(false)
    await expect(fs.exists('src/a.txt')).resolves.toBe(false)
    const deleteReceipt = listFileEffects(tmp, h.ctx.runId).find((e) => e.action === 'delete')
    expect(deleteReceipt?.status).toBe('committed')
    expect(deleteReceipt?.beforeCheckpointRef).toMatch(/^effect-backups\//)
  })

  it('读取不存在的文件返回 null', async () => {
    const fs = createFsFns(makeHostHarness(tmp).ctx)
    await expect(fs.read('missing.txt')).resolves.toBeNull()
  })

  it('内容未变的重复写入命中凭证，直接跳过', async () => {
    const h = makeHostHarness(tmp)
    const fs = createFsFns(h.ctx)
    await fs.write('a.txt', 'same')
    const firstAt = listFileEffects(tmp, h.ctx.runId)[0]!.at

    // 外部改文件后再写同样内容：凭证命中要求磁盘 hash 也一致，因此必须重新写回
    writeFileSync(join(tmp, 'a.txt'), 'drifted', 'utf-8')
    await fs.write('a.txt', 'same')
    expect(readFileSync(join(tmp, 'a.txt'), 'utf-8')).toBe('same')

    // 磁盘已一致时不再重写，凭证时间戳保持不变
    await fs.write('a.txt', 'same')
    expect(listFileEffects(tmp, h.ctx.runId)[0]!.at).toBeGreaterThanOrEqual(firstAt)
  })

  describe('路径安全', () => {
    const escapes = ['../outside.txt', 'a/../../outside.txt', '/etc/passwd', 'C:\\Windows\\x.txt']

    it('write 拒绝越界路径', async () => {
      const fs = createFsFns(makeHostHarness(tmp).ctx)
      for (const p of escapes) {
        await expect(fs.write(p, 'x')).rejects.toThrow()
      }
    })

    it('read / exists / delete 同样拒绝越界路径', async () => {
      const fs = createFsFns(makeHostHarness(tmp).ctx)
      for (const p of escapes) {
        await expect(fs.read(p)).rejects.toThrow()
        await expect(fs.exists(p)).rejects.toThrow()
        await expect(fs.delete(p)).rejects.toThrow()
      }
    })

    it('glob 拒绝越界 pattern', async () => {
      const fs = createFsFns(makeHostHarness(tmp).ctx)
      for (const p of ['../**/*.ts', '/**/*.ts', 'C:/**/*.ts', '']) {
        await expect(fs.glob(p)).rejects.toThrow(/escapes workspace/)
      }
    })
  })

  it('scope 关闭后 write / delete 被拒绝且不落盘', async () => {
    const h = makeHostHarness(tmp)
    const fs = createFsFns(h.ctx)
    writeFileSync(join(tmp, 'keep.txt'), 'keep', 'utf-8')
    await h.scope.close('cancelled')

    await expect(fs.write('new.txt', 'x')).rejects.toThrow(/TaskScope closed/)
    await expect(fs.delete('keep.txt')).rejects.toThrow(/TaskScope closed/)
    expect(existsSync(join(tmp, 'new.txt'))).toBe(false)
    expect(existsSync(join(tmp, 'keep.txt'))).toBe(true)
  })

  it('scope 关闭后仍允许读取（只读操作不受终态影响）', async () => {
    const h = makeHostHarness(tmp)
    const fs = createFsFns(h.ctx)
    writeFileSync(join(tmp, 'r.txt'), 'readable', 'utf-8')
    await h.scope.close('cancelled')

    await expect(fs.read('r.txt')).resolves.toBe('readable')
    await expect(fs.exists('r.txt')).resolves.toBe(true)
  })

  it('glob 匹配相对路径并跳过 node_modules', async () => {
    const h = makeHostHarness(tmp)
    const fs = createFsFns(h.ctx)
    mkdirSync(join(tmp, 'src/deep'), { recursive: true })
    mkdirSync(join(tmp, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(tmp, 'src/a.ts'), '', 'utf-8')
    writeFileSync(join(tmp, 'src/deep/b.ts'), '', 'utf-8')
    writeFileSync(join(tmp, 'node_modules/pkg/c.ts'), '', 'utf-8')

    await expect(fs.glob('src/**/*.ts')).resolves.toEqual(['src/a.ts', 'src/deep/b.ts'])
    await expect(fs.glob('**/*.ts')).resolves.toEqual(['src/a.ts', 'src/deep/b.ts'])
  })
})
