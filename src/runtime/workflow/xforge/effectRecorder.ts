import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { FileEffectRecorder, FileEffectToken } from '../../tools/types'
import { atomicWriteFileSync } from '../../storage/atomicFile'
import { getXForgeRunRoot } from './stageArtifacts'
import {
  buildFileEffectReceipt,
  commitFileEffect,
  hashContent,
  hashFileIfExists,
  recordFileEffect
} from '../v2/EffectReceipt'

/**
 * 把普通 write/edit 接入 XForge 的持久化副作用协议。
 * prepared receipt 与改前备份先落盘，目标文件成功写入后再提交 afterHash。
 */
export class XForgeFileEffectRecorder implements FileEffectRecorder {
  constructor(
    private readonly workspaceRoot: string,
    private readonly runId: string,
    private readonly getStepId: () => string
  ) {}

  prepareFileWrite(
    absolutePath: string,
    action: 'create' | 'modify'
  ): FileEffectToken {
    const effectId = randomUUID()
    const beforeHash = hashFileIfExists(absolutePath)
    let beforeCheckpointRef: string | null = null
    if (existsSync(absolutePath)) {
      beforeCheckpointRef = `effect-backups/${effectId}.bak`
      const backupPath = join(getXForgeRunRoot(this.workspaceRoot, this.runId), beforeCheckpointRef)
      mkdirSync(dirname(backupPath), { recursive: true })
      atomicWriteFileSync(backupPath, readFileSync(absolutePath))
    }
    recordFileEffect(
      this.workspaceRoot,
      buildFileEffectReceipt({
        workspaceRoot: this.workspaceRoot,
        runId: this.runId,
        stepId: this.getStepId(),
        idempotencyKey: `${this.getStepId()}:${effectId}`,
        absPath: absolutePath,
        action,
        beforeHash,
        beforeCheckpointRef,
        afterHash: null,
        effectId,
        status: 'prepared'
      })
    )
    return { effectId }
  }

  commitFileWrite(token: FileEffectToken, absolutePath: string): void {
    const afterHash = hashContent(readFileSync(absolutePath))
    commitFileEffect(this.workspaceRoot, this.runId, token.effectId, { afterHash })
  }
}
