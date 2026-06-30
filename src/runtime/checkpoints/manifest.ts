/**
 * Manifest 读写
 * 负责将 CheckpointManifest 持久化到 manifest.json 并读取回来
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { CheckpointManifest } from './types'

/** manifest 文件名 */
const MANIFEST_FILE = 'manifest.json'

/** 获取指定消息的 checkpoint 目录 */
export function getCheckpointDir(
  checkpointRoot: string,
  sessionId: string,
  messageId: string
): string {
  return join(checkpointRoot, sessionId, messageId)
}

/** 获取 manifest 文件路径 */
export function getManifestPath(
  checkpointRoot: string,
  sessionId: string,
  messageId: string
): string {
  return join(getCheckpointDir(checkpointRoot, sessionId, messageId), MANIFEST_FILE)
}

/** 获取 reverse 备份目录（改动前内容） */
export function getFilesDir(
  checkpointRoot: string,
  sessionId: string,
  messageId: string
): string {
  return join(getCheckpointDir(checkpointRoot, sessionId, messageId), 'files')
}

/** 获取 forward 快照目录（改动后内容，Tier 2 分支重放用） */
export function getForwardDir(
  checkpointRoot: string,
  sessionId: string,
  messageId: string
): string {
  return join(getCheckpointDir(checkpointRoot, sessionId, messageId), 'forward')
}

/** 创建并写入 manifest 文件（目录不存在时自动创建） */
export function writeManifest(
  checkpointRoot: string,
  manifest: CheckpointManifest
): void {
  const dir = getCheckpointDir(checkpointRoot, manifest.sessionId, manifest.messageId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, MANIFEST_FILE)
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 读取指定消息的 manifest，不存在时返回 null */
export function readManifest(
  checkpointRoot: string,
  sessionId: string,
  messageId: string
): CheckpointManifest | null {
  const filePath = getManifestPath(checkpointRoot, sessionId, messageId)
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as CheckpointManifest
  } catch {
    return null
  }
}
