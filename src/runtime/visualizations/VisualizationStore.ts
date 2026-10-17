/**
 * VisualizationStore — 会话内可视化的不可变快照存储
 *
 * 路径：{sessionsDir}/{sessionId}/visualizations/{sha256}.html
 * 文件名即内容 sha256：同内容天然去重；读取时复核摘要，被改写或截断的文件不会冒充原快照。
 * 随 SessionStore.delete() 的递归删除一并清理。
 */
import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import * as path from 'path'
import { atomicWriteFile } from '../storage/atomicFile'
import {
  buildVisualizationUri,
  isVisualizationAddress,
  MAX_VISUALIZATION_HTML_BYTES,
  type VisualizationAddress,
  type VisualizationDocumentStatus
} from '../../shared/visualization'

export type VisualizationSnapshotRead =
  | { status: Extract<VisualizationDocumentStatus, 'ok'>; html: string }
  | { status: Exclude<VisualizationDocumentStatus, 'ok'> }

export interface PublishedVisualization {
  uri: string
  sha256: string
  bytes: number
}

export class VisualizationStore {
  /** 原子写的临时文件名由目标路径派生：同一快照的并发发布必须共享一次写入 */
  private readonly pendingWrites = new Map<string, Promise<void>>()

  constructor(private readonly sessionsDir: string) {}

  async publish(sessionId: string, html: string): Promise<PublishedVisualization> {
    const content = Buffer.from(html, 'utf8')
    if (content.length > MAX_VISUALIZATION_HTML_BYTES) {
      throw new Error(`可视化体积 ${content.length} 字节，超过上限`)
    }
    const address = { sessionId, sha256: createHash('sha256').update(content).digest('hex') }
    const uri = buildVisualizationUri(address)
    await this.writeOnce(this.resolvePath(address), content)
    return { uri, sha256: address.sha256, bytes: content.length }
  }

  async read(address: VisualizationAddress): Promise<VisualizationSnapshotRead> {
    const filePath = this.resolvePath(address)
    let size: number
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return { status: 'missing' }
      size = info.size
    } catch {
      return { status: 'missing' }
    }
    if (size > MAX_VISUALIZATION_HTML_BYTES) return { status: 'corrupt' }
    let content: Buffer
    try {
      content = await readFile(filePath)
    } catch {
      return { status: 'corrupt' }
    }
    const digest = createHash('sha256').update(content).digest('hex')
    return digest === address.sha256 ? { status: 'ok', html: content.toString('utf8') } : { status: 'corrupt' }
  }

  private resolvePath(address: VisualizationAddress): string {
    if (!isVisualizationAddress(address)) {
      throw new Error(`非法的可视化地址: ${address.sessionId}/${address.sha256}`)
    }
    return path.join(this.sessionsDir, address.sessionId, 'visualizations', `${address.sha256}.html`)
  }

  private writeOnce(filePath: string, content: Buffer): Promise<void> {
    const pending = this.pendingWrites.get(filePath)
    if (pending) return pending
    const write = (async () => {
      if (await isFile(filePath)) return
      await atomicWriteFile(filePath, content)
    })().finally(() => {
      this.pendingWrites.delete(filePath)
    })
    this.pendingWrites.set(filePath, write)
    return write
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}
