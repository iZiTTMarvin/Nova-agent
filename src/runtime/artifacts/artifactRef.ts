/**
 * artifact:// 协议引用：id 必选；sha256/bytes 可选。
 *
 * 兼容：仅含 id 的旧指针（OutputSink 升级前）。
 * 删除条件：会话/评测中不再出现无 query 的 artifact:// 引用，且相关兼容测试删除后可移除 id-only 分支。
 */
import { createHash } from 'crypto'
import { createReadStream } from 'fs'

const ARTIFACT_SCHEME = 'artifact://'
const REF_WITH_HASH =
  /^artifact:\/\/([^?/\s]+)\?sha256=([0-9a-f]+)&bytes=(\d+)$/
const REF_ID_ONLY = /^artifact:\/\/([^?/\s]+)$/

export interface ArtifactRef {
  artifactId: string
  sha256?: string
  bytes?: number
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 对落盘全文做 SHA-256，供流式大输出指针使用。 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export function buildArtifactRef(
  artifactId: string,
  sha256: string,
  bytes: number
): string {
  return `${ARTIFACT_SCHEME}${artifactId}?sha256=${sha256}&bytes=${bytes}`
}

/** 解析 artifact 引用；无法识别时返回 null。 */
export function parseArtifactRef(ref: string): ArtifactRef | null {
  const trimmed = ref.trim()
  const withHash = trimmed.match(REF_WITH_HASH)
  if (withHash) {
    return {
      artifactId: withHash[1],
      sha256: withHash[2],
      bytes: Number(withHash[3])
    }
  }
  const idOnly = trimmed.match(REF_ID_ONLY)
  if (idOnly) {
    return { artifactId: idOnly[1] }
  }
  return null
}

export function isSafeArtifactId(id: string): boolean {
  return Boolean(id) && !id.includes('..') && !id.includes('/') && !id.includes('\\')
}

/**
 * 有 expected hash 时校验内容；缺 hash 的旧指针跳过。
 * 不一致返回结构化错误文案，一致或跳过返回 null。
 */
export function integrityMismatchError(
  content: string,
  expectedSha256: string | undefined,
  artifactId: string
): string | null {
  if (!expectedSha256) return null
  const actual = sha256Hex(content)
  if (actual === expectedSha256) return null
  return JSON.stringify({
    ok: false,
    error: 'integrity_mismatch',
    expected: expectedSha256,
    actual,
    artifactId
  })
}
