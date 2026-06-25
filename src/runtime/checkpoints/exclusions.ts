/**
 * Checkpoint 备份排除规则
 *
 * 核心职责：
 * 1. 维护内置静态排除清单（目录、文件、扩展名）
 * 2. 判断给定相对路径是否应被跳过备份
 *
 * 设计约束：
 * - 路径统一使用 POSIX 风格（/ 分隔），调用方负责转换
 * - 排除规则只影响备份，不影响正常文件操作
 */

/** 默认按目录名排除（任意层级匹配） */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.cache'
])

/** 默认按文件名精确排除 */
const EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
  'pnpm-debug.log'
])

/** 默认按扩展名排除（二进制、媒体、日志、压缩包等） */
const EXCLUDED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.log', '.tmp', '.temp', '.swp', '.swo'
])

/**
 * 判断相对路径是否命中内置排除规则。
 *
 * 规则优先级：目录名 > 文件名 > 扩展名。
 * 路径示例：
 * - 'node_modules/foo/index.js' → true（目录名匹配）
 * - 'src/.env' → true（文件名匹配）
 * - 'assets/logo.png' → true（扩展名匹配）
 *
 * @param relPath 相对路径（POSIX 风格，不含前导 /）
 */
export function isExcludedPath(relPath: string): boolean {
  if (!relPath) return false

  const segments = relPath.split('/')
  const fileName = segments[segments.length - 1]

  // 1. 任意层级命中排除目录
  for (const segment of segments) {
    if (EXCLUDED_DIRS.has(segment)) return true
  }

  // 2. 文件名精确匹配
  if (EXCLUDED_FILES.has(fileName)) return true

  // 3. 扩展名匹配
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot > 0) {
    const ext = fileName.slice(lastDot).toLowerCase()
    if (EXCLUDED_EXTENSIONS.has(ext)) return true
  }

  return false
}
