/**
 * ArtifactStore — 会话级大输出落盘存储
 *
 * 路径：{sessionsDir}/{sessionId}/artifacts/{id}
 * ID 使用短 uuid（12 位 hex），并发写入互不冲突。
 */
import { copyFile, mkdir, readFile, rename, unlink, writeFile, access, stat, open, realpath } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import { EVIDENCE_ARTIFACT_MAX_BYTES, type EvidenceReference } from '../../shared/evidence'

export interface ArtifactMeta {
  id: string
  sessionId: string
  toolName: string
  createdAt: number
  totalBytes: number
  totalLines: number
  truncated: boolean
}

/** 拒绝路径穿越：sessionId / artifact id 均不得含分隔符或 .. */
function assertSafeSegment(label: string, value: string): void {
  if (!value || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(`非法 ${label}: ${value}`)
  }
}

/** 生成会话内唯一的短 artifact ID */
function generateArtifactId(): string {
  return randomBytes(6).toString('hex')
}

function contentAddressedArtifactId(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

/** 统计文本行数（空字符串为 0 行，与 split 口径一致） */
export function countTextLines(text: string): number {
  if (text.length === 0) return 0
  return text.split('\n').length
}

export class ArtifactStore {
  constructor(private readonly sessionsDir: string) {}

  async resolveEvidence(sessionId: string, id: string, sourceTool: string): Promise<Extract<EvidenceReference, { kind: 'artifact' }>> {
    const { bytes } = await this.readEvidenceFile(sessionId, id, false)
    return { kind: 'artifact', artifactId: id, mimeType: 'text/plain', bytes, sourceTool, description: '工具输出' }
  }

  async readEvidence(sessionId: string, id: string): Promise<string> {
    return (await this.readEvidenceFile(sessionId, id, true)).text
  }

  private async readEvidenceFile(sessionId: string, id: string, full: boolean): Promise<{ bytes: number; text: string }> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^(?:[a-f0-9]{12}|sha256-[a-f0-9]{64})$/.test(id)) {
      throw new Error('Artifact 引用无效')
    }
    const filePath = this.resolvePath(sessionId, id)
    if (await realpath(filePath) !== join(await realpath(this.sessionsDir), sessionId, 'artifacts', id)) throw new Error('Artifact 引用越界')
    const file = await open(filePath, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('Artifact 不是普通文件')
      if (full && info.size > EVIDENCE_ARTIFACT_MAX_BYTES) throw new Error('Artifact 超出文本查看大小限制')
      const buffer = Buffer.alloc(Math.min(info.size, EVIDENCE_ARTIFACT_MAX_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const content = buffer.subarray(0, bytesRead)
      if (content.includes(0)) throw new Error('Artifact 不是文本文件')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: !full && info.size > buffer.length }) }
      catch { throw new Error('Artifact 不是 UTF-8 文本') }
      return { bytes: info.size, text }
    } finally { await file.close() }
  }

  /** 返回会话 artifact 目录绝对路径 */
  getArtifactsDir(sessionId: string): string {
    assertSafeSegment('sessionId', sessionId)
    return join(this.sessionsDir, sessionId, 'artifacts')
  }

  /** 解析 artifact 文件绝对路径（拒绝路径穿越） */
  resolvePath(sessionId: string, id: string): string {
    assertSafeSegment('sessionId', sessionId)
    assertSafeSegment('artifactId', id)
    return join(this.getArtifactsDir(sessionId), id)
  }

  /** 将全文写入 artifact 目录 */
  async write(
    sessionId: string,
    content: string,
    meta: { toolName: string; truncated?: boolean }
  ): Promise<ArtifactMeta> {
    return this.writeAtId(sessionId, generateArtifactId(), content, meta)
  }

  /** 同一会话内按正文复用稳定 ID，供可重复生成的请求投影使用。 */
  async writeContentAddressed(
    sessionId: string,
    content: string,
    meta: { toolName: string; truncated?: boolean }
  ): Promise<ArtifactMeta> {
    return this.writeAtId(sessionId, contentAddressedArtifactId(content), content, meta)
  }

  private async writeAtId(
    sessionId: string,
    id: string,
    content: string,
    meta: { toolName: string; truncated?: boolean }
  ): Promise<ArtifactMeta> {
    assertSafeSegment('sessionId', sessionId)
    assertSafeSegment('artifactId', id)
    const dir = this.getArtifactsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, id)
    try {
      const existing = await readFile(filePath, 'utf8')
      if (existing !== content) {
        throw new Error(`artifact 内容寻址冲突: ${id}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFile(filePath, content, 'utf8')
    }
    return {
      id,
      sessionId,
      toolName: meta.toolName,
      createdAt: Date.now(),
      totalBytes: Buffer.byteLength(content, 'utf8'),
      totalLines: countTextLines(content),
      truncated: meta.truncated ?? false
    }
  }

  /**
   * 将已有文件移入 artifact 目录。
   * 同盘 rename；跨盘（EXDEV）回退 copy + 删除源文件。
   */
  async writeFromPath(
    sessionId: string,
    sourcePath: string,
    meta: { toolName: string; truncated?: boolean }
  ): Promise<ArtifactMeta> {
    assertSafeSegment('sessionId', sessionId)
    const id = generateArtifactId()
    const dir = this.getArtifactsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const destPath = join(dir, id)

    try {
      await rename(sourcePath, destPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        await copyFile(sourcePath, destPath)
        await unlink(sourcePath).catch(() => {})
      } else if (code === 'ENOENT') {
        // 源文件可能已被同目录 rename 移走，确认目标存在
        await access(destPath, constants.F_OK)
      } else {
        throw err
      }
    }

    const destStat = await stat(destPath)
    if (!destStat.isFile()) {
      throw new Error(`artifact 目标不是普通文件: ${destPath}`)
    }

    const content = await readFile(destPath, 'utf8')
    return {
      id,
      sessionId,
      toolName: meta.toolName,
      createdAt: Date.now(),
      totalBytes: Buffer.byteLength(content, 'utf8'),
      totalLines: countTextLines(content),
      truncated: meta.truncated ?? true
    }
  }

  /**
   * 读取 artifact 全文或按行切片。
   * offset 为 1-based 行号；limit 为最大行数。
   */
  async read(
    sessionId: string,
    id: string,
    opts?: { offset?: number; limit?: number }
  ): Promise<string> {
    const filePath = this.resolvePath(sessionId, id)
    const content = await readFile(filePath, 'utf8')

    if (opts?.offset === undefined && opts?.limit === undefined) {
      return content
    }

    const lines = content.split('\n')
    const start = Math.max(0, (opts?.offset ?? 1) - 1)
    const limit = opts?.limit ?? lines.length
    return lines.slice(start, start + limit).join('\n')
  }
}
