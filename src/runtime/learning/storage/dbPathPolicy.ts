import { dirname, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function isPathUnder(child: string, root: string): boolean {
  const c = normalize(resolve(child))
  const r = normalize(resolve(root))
  const prefix = r.endsWith('\\') || r.endsWith('/') ? r : `${r}${process.platform === 'win32' ? '\\' : '/'}`
  return c.toLowerCase().startsWith(prefix.toLowerCase()) || c.toLowerCase() === r.toLowerCase()
}

function allowedRoots(userLearningRoot: string | null): string[] {
  const roots = [tmpdir()]
  const testRoot = process.env.NOVA_LEARNING_TEST_DB_ROOT
  if (testRoot && testRoot.trim()) {
    roots.push(resolve(testRoot.trim()))
  }
  if (userLearningRoot) {
    roots.push(resolve(userLearningRoot))
  }
  return roots
}

/** 允许目录来自宿主初始化，不接受普通数据库命令扩大路径权限。 */
export function assertLearningDbPathAllowed(dbPath: string, userLearningRoot: string | null = null): void {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('学习数据库路径无效')
  }
  const resolved = resolve(dbPath)
  const dir = dirname(resolved)
  if (!allowedRoots(userLearningRoot).some(root => isPathUnder(dir, root))) {
    throw new Error('学习数据库路径不在允许的临时或测试目录内')
  }
}
