/**
 * 原子文件写入原语
 *
 * 同目录临时文件 → fsync → rename 覆盖目标，避免 writeFileSync 中途崩溃导致整文件损坏或截断。
 * Windows 下 Node rename 使用 MOVEFILE_REPLACE_EXISTING，可覆盖已有文件。
 */
import * as fs from 'fs'
import * as path from 'path'

const TMP_SUFFIX = '.tmp'

/** 原子写入文本或二进制内容到目标路径 */
export function atomicWriteFileSync(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf8'
): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpPath = `${filePath}${TMP_SUFFIX}`
  const fd = fs.openSync(tmpPath, 'w')
  try {
    if (typeof content === 'string') {
      fs.writeFileSync(fd, content, encoding)
    } else {
      fs.writeFileSync(fd, content)
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
}

/** 主进程热路径使用的异步原子写入，协议与同步版本一致。 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf8'
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmpPath = `${filePath}${TMP_SUFFIX}`
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    if (typeof content === 'string') {
      await handle.writeFile(content, { encoding })
    } else {
      await handle.writeFile(content)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.promises.rename(tmpPath, filePath)
}

/**
 * 启动时清理遗留的 .tmp 文件（上次崩溃可能留下）。
 * 仅扫描已知落盘根目录下的直接子树，避免全 userData 深度遍历。
 */
export function cleanupStaleAtomicTmpFiles(appDataPath: string): void {
  const roots = [
    path.join(appDataPath, 'sessions'),
    path.join(appDataPath, 'settings'),
    path.join(appDataPath, 'runs')
  ]
  for (const root of roots) {
    cleanupTmpInTree(root)
  }
}

function cleanupTmpInTree(dir: string): void {
  if (!fs.existsSync(dir)) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      cleanupTmpInTree(fullPath)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(TMP_SUFFIX)) {
      try {
        fs.unlinkSync(fullPath)
      } catch {
        // 清理失败不阻塞启动
      }
    }
  }
}
