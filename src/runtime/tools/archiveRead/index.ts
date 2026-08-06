/**
 * archive_read — 按结构/关键词/分页读回归档的工具结果内容，响应始终有界。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import {
  integrityMismatchError,
  isSafeArtifactId,
  parseArtifactRef
} from '../../artifacts/artifactRef'

export const ARCHIVE_READ_MAX_RESPONSE_CHARS = 7500
export const ARCHIVE_READ_DEFAULT_LIMIT = 4000
export const ARCHIVE_READ_MAX_LIMIT = 6000

function shrinkLimitToFit(
  buildResponse: (limit: number) => string,
  initialLimit: number
): { limit: number; serialized: string } {
  let limit = initialLimit
  let serialized = buildResponse(limit)
  while (serialized.length > ARCHIVE_READ_MAX_RESPONSE_CHARS && limit > 1) {
    limit = Math.max(1, Math.floor(limit / 2))
    serialized = buildResponse(limit)
  }
  return { limit, serialized }
}

const TOOL_NAME = 'archive_read'

const TOOL_DESCRIPTION = '读取已被归档的工具输出内容。按结构预览、关键词搜索或分页读回正文，响应始终有界。'

const archiveReadTool: ToolExecutor = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: '归档占位符中的 resourceRef 字段'
      },
      operation: {
        type: 'string',
        enum: ['inspect', 'search', 'read'],
        default: 'inspect',
        description: 'inspect=查看结构摘要，search=关键词搜索，read=按行分页读回'
      },
      keyword: {
        type: 'string',
        description: 'search 操作时的搜索关键词'
      },
      offset: {
        type: 'number',
        default: 1,
        description: 'read 操作的起始行号（1-based）'
      },
      limit: {
        type: 'number',
        description: 'read 操作的最大行数'
      }
    },
    required: ['ref'],
    additionalProperties: false
  },
  executionMode: 'parallel',
  isConcurrencySafe: () => true,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
    if (!ref) {
      return { success: false, output: '', error: 'ref 参数不能为空' }
    }

    const parsed = parseArtifactRef(ref)
    if (!parsed || !isSafeArtifactId(parsed.artifactId)) {
      return { success: false, output: '', error: '无效的 ref 格式' }
    }

    const artifactStore = context.artifactStore
    const sessionId = context.sessionId
    if (!artifactStore || !sessionId) {
      return { success: false, output: '', error: 'archive_read 需要 artifactStore 与 sessionId' }
    }

    let content: string
    try {
      content = await artifactStore.read(sessionId, parsed.artifactId)
    } catch {
      return { success: false, output: '', error: '读取 artifact 失败' }
    }

    // 有 hash 时校验；旧指针缺 hash 时跳过（见 artifactRef 兼容删除条件）
    const mismatch = integrityMismatchError(content, parsed.sha256, parsed.artifactId)
    if (mismatch) {
      return { success: false, output: '', error: mismatch }
    }

    const operation = (typeof args.operation === 'string' ? args.operation : 'inspect') as
      | 'inspect'
      | 'search'
      | 'read'

    if (operation === 'inspect') {
      const lines = content.split('\n')
      const result = {
        ok: true,
        operation: 'inspect',
        totalBytes: Buffer.byteLength(content, 'utf8'),
        totalLines: lines.length,
        preview: lines.slice(0, 10).join('\n'),
        hint: 'operation: "read" with offset/limit for full text; "search" with keyword to locate lines'
      }
      return { success: true, output: JSON.stringify(result) }
    }

    if (operation === 'read') {
      const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1
      const requestedLimit = typeof args.limit === 'number' ? args.limit : ARCHIVE_READ_DEFAULT_LIMIT
      const effectiveLimit = Math.min(requestedLimit, ARCHIVE_READ_MAX_LIMIT)
      const lines = content.split('\n')
      const totalLines = lines.length

      const buildReadResponse = (limit: number) => {
        const start = Math.min(offset - 1, totalLines)
        const end = Math.min(start + limit, totalLines)
        const pageLines = lines.slice(start, end)
        const hasMore = end < totalLines
        const nextOffset = hasMore ? end + 1 : null
        const obj = {
          lines: pageLines,
          offset,
          limit,
          nextOffset,
          hasMore,
          totalLines
        }
        return JSON.stringify(obj)
      }

      const { limit, serialized } = shrinkLimitToFit(buildReadResponse, effectiveLimit)
      const start = Math.min(offset - 1, totalLines)
      const pageLines = lines.slice(start, Math.min(start + limit, totalLines))
      const hasMore = start + limit < totalLines
      const result = {
        lines: pageLines,
        offset,
        limit,
        nextOffset: hasMore ? start + limit + 1 : null,
        hasMore,
        totalLines
      }
      return { success: true, output: JSON.stringify(result) }
    }

    if (operation === 'search') {
      const keyword = typeof args.keyword === 'string' ? args.keyword : ''
      if (!keyword) {
        return { success: false, output: '', error: 'search 操作需要 keyword 参数' }
      }

      const lines = content.split('\n')
      const matches: Array<{
        line: number
        content: string
        contextBefore: string | null
        contextAfter: string | null
      }> = []

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(keyword)) {
          matches.push({
            line: i + 1,
            content: lines[i],
            contextBefore: i > 0 ? lines[i - 1] : null,
            contextAfter: i < lines.length - 1 ? lines[i + 1] : null
          })
        }
      }

      const buildSearchResponse = (maxMatches: number) => {
        const trimmed = matches.slice(0, maxMatches)
        const obj = { matches: trimmed, keyword, totalMatches: matches.length }
        return JSON.stringify(obj)
      }

      const serialized = buildSearchResponse(matches.length)
      if (serialized.length <= ARCHIVE_READ_MAX_RESPONSE_CHARS) {
        return { success: true, output: serialized }
      }

      // 二分收缩命中数
      let lo = 1
      let hi = matches.length
      let best = matches.length
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (buildSearchResponse(mid).length <= ARCHIVE_READ_MAX_RESPONSE_CHARS) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return { success: true, output: buildSearchResponse(best) }
    }

    return { success: false, output: '', error: `未知 operation: ${operation}` }
  }
}

export { archiveReadTool }
export default archiveReadTool
