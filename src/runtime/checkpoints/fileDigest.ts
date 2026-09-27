/**
 * 工作区文件字节摘要：diff 条目携带、拒绝恢复前比对用。
 */
import { createHash } from 'crypto'

/** 计算文件字节的 sha256 hex；与 DiffEntry.currentDigest 同一口径。 */
export function digestFileBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
