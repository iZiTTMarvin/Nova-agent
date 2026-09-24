import { dirname, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function isPathUnder(child: string, root: string): boolean {
  const c = normalize(resolve(child))
  const r = normalize(resolve(root))
  const prefix = r.endsWith('\\') || r.endsWith('/') ? r : `${r}${process.platform === 'win32' ? '\\' : '/'}`
  return c.toLowerCase().startsWith(prefix.toLowerCase()) || c.toLowerCase() === r.toLowerCase()
}

function allowedRoots(): string[] {
  const roots = [tmpdir()]
  const testRoot = process.env.NOVA_LEARNING_TEST_DB_ROOT
  if (testRoot && testRoot.trim()) {
    roots.push(resolve(testRoot.trim()))
  }
  return roots
}

/** Worker 打开库前校验：仅临时目录或显式测试根，避免误写 userData 或源码树。 */
export function assertLearningDbPathAllowed(dbPath: string): void {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('学习数据库路径无效')
  }
  const resolved = resolve(dbPath)
  const dir = dirname(resolved)
  if (!allowedRoots().some(root => isPathUnder(dir, root))) {
    throw new Error('学习数据库路径不在允许的临时或测试目录内')
  }
}
