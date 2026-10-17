import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VisualizationStore } from '../../../../src/runtime/visualizations/VisualizationStore'
import { MAX_VISUALIZATION_HTML_BYTES, parseVisualizationUri } from '../../../../src/shared/visualization'

let sessionsDir: string

beforeEach(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), 'nova-viz-store-'))
})

afterEach(async () => {
  await rm(sessionsDir, { recursive: true, force: true })
})

function snapshotDir(sessionId: string): string {
  return path.join(sessionsDir, sessionId, 'visualizations')
}

describe('VisualizationStore', () => {
  it('发布后按地址读回原文；同内容复用同一快照', async () => {
    const store = new VisualizationStore(sessionsDir)
    const html = '<!doctype html><p>你好，可视化</p>'
    const first = await store.publish('s1', html)
    const second = await store.publish('s1', html)

    expect(second.uri).toBe(first.uri)
    expect(first.bytes).toBe(Buffer.byteLength(html, 'utf8'))
    expect(await store.read(parseVisualizationUri(first.uri)!)).toEqual({ status: 'ok', html })
    expect(await readdir(snapshotDir('s1'))).toEqual([`${first.sha256}.html`])
  })

  it('并发发布同一内容共享一次写入，不残留临时文件', async () => {
    const store = new VisualizationStore(sessionsDir)
    const results = await Promise.all(Array.from({ length: 6 }, () => store.publish('s1', '<p>并发</p>')))

    expect(new Set(results.map(result => result.uri)).size).toBe(1)
    expect(await readdir(snapshotDir('s1'))).toEqual([`${results[0].sha256}.html`])
  })

  it('快照被改写后报告损坏，其他会话下报告不存在', async () => {
    const store = new VisualizationStore(sessionsDir)
    const published = await store.publish('s1', '<p>原文</p>')
    const address = parseVisualizationUri(published.uri)!

    expect(await store.read({ ...address, sessionId: 's2' })).toEqual({ status: 'missing' })
    await writeFile(path.join(snapshotDir('s1'), `${published.sha256}.html`), '<p>篡改</p>')
    expect(await store.read(address)).toEqual({ status: 'corrupt' })
  })

  it('超过体积上限或地址非法时拒绝', async () => {
    const store = new VisualizationStore(sessionsDir)
    await expect(store.publish('s1', 'x'.repeat(MAX_VISUALIZATION_HTML_BYTES + 1))).rejects.toThrow('超过上限')
    await expect(store.publish('../escape', '<p>x</p>')).rejects.toThrow('非法的可视化地址')
    await expect(store.read({ sessionId: '..', sha256: 'a'.repeat(64) })).rejects.toThrow('非法的可视化地址')
    expect(await readdir(sessionsDir)).toEqual([])
  })
})
