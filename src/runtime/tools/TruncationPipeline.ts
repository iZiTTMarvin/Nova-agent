import type { TruncationResult, TruncationMeta } from './grep-types'

const DEFAULT_MAX_MATCH_COUNT = 250
const DEFAULT_MAX_BYTE_SIZE = 100_000
const DEFAULT_MAX_LINE_LENGTH = 1000

export interface TruncationConfig {
  maxMatchCount?: number
  maxByteSize?: number
  maxLineLength?: number
}

export interface TruncationPipeline {
  apply(input: string): TruncationResult
}

export function createTruncationPipeline(config?: TruncationConfig): TruncationPipeline {
  const maxMatchCount = config?.maxMatchCount ?? DEFAULT_MAX_MATCH_COUNT
  const maxByteSize = config?.maxByteSize ?? DEFAULT_MAX_BYTE_SIZE
  const maxLineLength = config?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH

  return {
    apply(input: string): TruncationResult {
      let output = input
      let truncated = false
      let meta: TruncationMeta | undefined

      const lines = output.split('\n')
      const totalLines = lines.length

      if (totalLines > maxMatchCount) {
        output = lines.slice(0, maxMatchCount).join('\n')
        truncated = true
        meta = {
          truncatedAt: 'match_count',
          shown: maxMatchCount,
          total: totalLines,
          limit: maxMatchCount
        }
        return { output, truncated, meta }
      }

      const byteSize = Buffer.byteLength(output, 'utf-8')
      if (byteSize > maxByteSize) {
        let truncatedOutput = ''
        let currentSize = 0
        const outputLines = output.split('\n')

        for (let i = 0; i < outputLines.length; i++) {
          const line = outputLines[i]
          const lineBytes = Buffer.byteLength(line, 'utf-8')
          const separatorBytes = i > 0 ? 1 : 0

          if (currentSize + separatorBytes + lineBytes > maxByteSize) {
            truncated = true
            meta = {
              truncatedAt: 'byte_size',
              shown: Math.round(currentSize / 1024),
              total: Math.round(byteSize / 1024),
              limit: Math.round(maxByteSize / 1024)
            }
            break
          }

          if (i > 0) {
            truncatedOutput += '\n'
            currentSize += 1
          }
          truncatedOutput += line
          currentSize += lineBytes
        }

        output = truncatedOutput
      }

      const outputLines = output.split('\n')
      const processedLines: string[] = []
      let lineTruncated = false

      for (const line of outputLines) {
        if (line.length > maxLineLength) {
          processedLines.push(line.slice(0, maxLineLength) + '...[截断]')
          lineTruncated = true
        } else {
          processedLines.push(line)
        }
      }

      if (lineTruncated) {
        output = processedLines.join('\n')
        truncated = true
        if (!meta) {
          meta = {
            truncatedAt: 'line_length',
            shown: processedLines.filter(l => l.endsWith('...[截断]')).length,
            limit: maxLineLength
          }
        }
      }

      return { output, truncated, meta }
    }
  }
}
