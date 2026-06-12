/**
 * Skill zip 解压与目录发现（Task 8）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, normalize, sep } from 'path'
import { tmpdir } from 'os'
import * as yauzl from 'yauzl'
import { parseSkillMarkdown } from './frontmatter'

const SKILL_FILE = 'SKILL.md'

/** 解压 zip 到目标目录 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('无法打开 zip 文件'))
        return
      }

      zipfile.readEntry()

      zipfile.on('entry', entry => {
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

        mkdirSync(dirname(fullPath), { recursive: true })

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            reject(streamErr ?? new Error(`无法读取 zip 条目：${entry.fileName}`))
            return
          }

          const writeStream = createWriteStream(fullPath)
          readStream.pipe(writeStream)
          writeStream.on('finish', () => zipfile.readEntry())
          writeStream.on('error', reject)
        })
      })

      zipfile.on('end', () => resolve())
      zipfile.on('error', reject)
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

/** 下载 https URL 到本地文件（30s 超时） */
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

    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(destPath, buffer)
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
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
