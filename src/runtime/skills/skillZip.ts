/**
 * Skill zip 解压与目录发现（Task 8）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, normalize, sep } from 'path'
import { tmpdir } from 'os'
import * as yauzl from 'yauzl'
import { parseSkillMarkdown } from './frontmatter'

const SKILL_FILE = 'SKILL.md'

/**
 * 解压文件数上限：恶意 zip 可能塞入海量小文件拖慢文件系统 / 耗尽 inode。
 * skill 包正常只有 SKILL.md + 少量辅助文件，1000 已经是宽松上限。
 */
const MAX_EXTRACTED_FILE_COUNT = 1000

/**
 * 解压总字节数上限：防范 zip bomb（高压缩比 zip 解压后远大于原始大小）。
 * 100MB 足够任何合理 skill 包，超此值视为异常。
 */
const MAX_EXTRACTED_TOTAL_SIZE = 100 * 1024 * 1024

/** 解压 zip 到目标目录 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    let fileCount = 0
    let totalSize = 0
    let rejected = false

    const fail = (err: Error): void => {
      if (rejected) return
      rejected = true
      // 解压失败时清理半成品，避免污染目标目录
      try {
        rmSync(destDir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响错误传递
      }
      reject(err)
    }

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        fail(err ?? new Error('无法打开 zip 文件'))
        return
      }

      zipfile.readEntry()

      zipfile.on('entry', entry => {
        if (rejected) {
          zipfile.close()
          return
        }

        fileCount++
        if (fileCount > MAX_EXTRACTED_FILE_COUNT) {
          fail(new Error(`解压文件数超过上限 ${MAX_EXTRACTED_FILE_COUNT}，疑似 zip bomb`))
          zipfile.close()
          return
        }

        const entryPath = normalize(entry.fileName.replace(/\\/g, '/'))
        if (entryPath.includes('..')) {
          zipfile.readEntry()
          return
        }

        const fullPath = join(destDir, entryPath)

        if (/\/$/.test(entry.fileName)) {
          mkdirSync(fullPath, { recursive: true })
          zipfile.readEntry()
          return
        }

        // 单文件大小预检（yauzl 提供 uncompressedSize）
        if (entry.uncompressedSize > MAX_EXTRACTED_TOTAL_SIZE) {
          fail(new Error(`单文件过大：${entry.fileName} (${entry.uncompressedSize} bytes)`))
          zipfile.close()
          return
        }

        mkdirSync(dirname(fullPath), { recursive: true })

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (rejected) return
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error(`无法读取 zip 条目：${entry.fileName}`))
            return
          }

          const writeStream = createWriteStream(fullPath)
          let entrySize = 0

          readStream.on('data', (chunk: Buffer | string) => {
            entrySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
            totalSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
            if (totalSize > MAX_EXTRACTED_TOTAL_SIZE) {
              fail(new Error(`解压总大小超过上限 ${MAX_EXTRACTED_TOTAL_SIZE} bytes，疑似 zip bomb`))
              writeStream.destroy()
              readStream.destroy()
              zipfile.close()
            }
          })

          writeStream.on('finish', () => {
            if (!rejected) zipfile.readEntry()
          })
          writeStream.on('error', (e: Error) => fail(e))
          readStream.pipe(writeStream)
        })
      })

      zipfile.on('end', () => {
        if (!rejected) resolve()
      })
      zipfile.on('error', (e: Error) => fail(e))
    })
  })
}

/** 在解压目录中查找包含 SKILL.md 的技能根目录 */
export function findSkillRoot(extractedDir: string): string {
  const direct = join(extractedDir, SKILL_FILE)
  if (existsSync(direct)) {
    return extractedDir
  }

  const children = readdirSync(extractedDir, { withFileTypes: true }).filter(e => e.isDirectory())
  for (const child of children) {
    const candidate = join(extractedDir, child.name)
    if (existsSync(join(candidate, SKILL_FILE))) {
      return candidate
    }
  }

  throw new Error('zip 中未找到 SKILL.md（支持根目录或单层子目录）')
}

/** 从技能目录解析名称，校验 frontmatter */
export function validateSkillDirectory(skillDir: string): { name: string; dirName: string } {
  const dirName = skillDir.split(sep).pop() ?? 'skill'
  const skillPath = join(skillDir, SKILL_FILE)
  if (!existsSync(skillPath)) {
    throw new Error('技能目录缺少 SKILL.md')
  }

  const content = readFileSync(skillPath, 'utf-8')
  const manifest = parseSkillMarkdown(content, {
    fallbackName: dirName,
    source: 'global',
    sourcePath: skillPath,
    directory: skillDir
  })

  if (manifest.invalid) {
    throw new Error(manifest.invalidReason ?? 'SKILL.md frontmatter 无效')
  }

  return { name: manifest.name, dirName }
}

/** 创建临时目录并在用完后清理 */
export function createTempSkillDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `nova-skill-${prefix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不阻断主流程
      }
    }
  }
}

/** 下载文件大小上限：与 extractZip 的解压上限对齐，避免下载阶段就被撑爆 */
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024

/** 下载 https URL 到本地文件（30s 超时 + 100MB 大小上限） */
export async function downloadHttpsToFile(url: string, destPath: string): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error('仅支持 https:// 链接导入')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`)
    }

    // 服务端声明 Content-Length 时预检：直接拒绝超大响应，不浪费带宽
    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10)
    if (contentLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(`下载文件过大：${contentLength} bytes（上限 ${MAX_DOWNLOAD_SIZE} bytes）`)
    }

    // 流式下载：服务端可能不返回 Content-Length，或返回值不实，需要在写入时累计校验
    mkdirSync(dirname(destPath), { recursive: true })
    const writeStream = createWriteStream(destPath)
    let downloaded = 0
    let writeStreamClosed = false

    const safeCloseWriteStream = (): void => {
      if (!writeStreamClosed) {
        writeStreamClosed = true
        writeStream.destroy()
      }
    }

    try {
      const body = response.body
      if (!body) {
        throw new Error('响应没有 body')
      }
      for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
        downloaded += chunk.length
        if (downloaded > MAX_DOWNLOAD_SIZE) {
          safeCloseWriteStream()
          // 清理半成品
          try { rmSync(destPath, { force: true }) } catch { /* ignore */ }
          throw new Error(`下载大小超过上限 ${MAX_DOWNLOAD_SIZE} bytes`)
        }
        writeStream.write(chunk)
      }
    } finally {
      safeCloseWriteStream()
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // 清理半成品
      try { rmSync(destPath, { force: true }) } catch { /* ignore */ }
      throw new Error('下载超时（30 秒）')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 判断路径是否为 zip 文件 */
export function isZipPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zip')
}
