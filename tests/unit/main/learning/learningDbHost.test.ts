import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureLearningDatabaseReady,
  getLearningProgressOrNull,
  shutdownLearningDatabase
} from '../../../../src/main/learning/LearningDbHost'

// 学习库宿主拥有模块级连接状态：fake 掉 worker client 边界，跑真实宿主状态机，
// 保护「worker 崩溃后 ensure 丢弃死实例并重建」的恢复路径。
const fake = vi.hoisted(() => ({
  clients: [] as Array<{ started: boolean; closed: boolean; crashed: boolean; openedPath: string }>,
  userDataDirs: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      const dir = mkdtempSync(join(tmpdir(), 'nova-learn-dbhost-'))
      fake.userDataDirs.push(dir)
      return dir
    }
  }
}))

vi.mock('../../../../src/runtime/learning/storage/LearningDbWorkerClient', () => ({
  LearningDbWorkerClient: class {
    started = false
    closed = false
    crashed = false
    openedPath = ''
    constructor() {
      fake.clients.push(this)
    }
    async start() { this.started = true }
    async open(openedPath: string) { this.openedPath = openedPath }
    isCrashed() { return this.crashed }
    async close() { this.closed = true }
  }
}))

describe('learning db host 崩溃恢复', () => {
  afterEach(async () => {
    await shutdownLearningDatabase()
    fake.clients.length = 0
    for (const dir of fake.userDataDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理竞态 */ }
    }
  })

  it('worker 崩溃后 ensure 丢弃死实例并重建连接', async () => {
    const first = await ensureLearningDatabaseReady()
    expect(first).toBe(getLearningProgressOrNull())
    expect(fake.clients).toHaveLength(1)

    fake.clients[0]!.crashed = true
    const second = await ensureLearningDatabaseReady()

    expect(fake.clients).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(getLearningProgressOrNull()).toBe(second)
    expect(fake.clients[0]!.closed).toBe(true)
    expect(fake.clients[1]!.started).toBe(true)
    expect(fake.clients[1]!.openedPath).toContain('learning.db')
  })

  it('worker 存活时 ensure 复用现有连接，不重建', async () => {
    const first = await ensureLearningDatabaseReady()
    const again = await ensureLearningDatabaseReady()

    expect(again).toBe(first)
    expect(fake.clients).toHaveLength(1)
    expect(fake.clients[0]!.closed).toBe(false)
  })
})
