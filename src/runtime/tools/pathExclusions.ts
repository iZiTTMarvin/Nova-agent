/**
 * pathExclusions — 路径排除共享模块
 *
 * 为 find / ls / grep 三处只读工具提供统一的目录排除能力，避免每处各写一份
 * 排除清单导致漂移（kilocode 踩过的坑：它精心维护的排除清单只喂给了 watcher，
 * 没喂给 glob/grep 工具）。
 *
 * 分两层职责：
 * 1. 第 1 层 `BUILD_SKIP_DIRS`：硬编码"任何语言/工具链都绝不会想搜到的目录"
 *    （构建产物、依赖目录、缓存）。不放用户可能想搜的目录（如 .github / .vscode），
 *    那些交给第 2 层 gitignore。
 * 2. 第 2 层 `loadIgnoreMatcher`：尊重用户项目 `.gitignore`，支持 `!` 取反与目录继承。
 */
import { readFile as readFileAsync } from 'fs/promises'
import { join } from 'path'

// picomatch 是 Vite 传递依赖，node_modules 中可用但无自带类型声明。
// 用 @ts-expect-error 抑制 TS7016，仅本文件使用，影响面可控。
// @ts-expect-error - picomatch is a transitive dep without @types/picomatch
import picomatch from 'picomatch'

/**
 * 第 1 层：硬编码"永远不遍历"目录。
 *
 * 设计原则：只放构建产物 / 依赖 / 缓存。用户可能想看的目录（.github / .vscode /
 * .idea 配置等）不放进来——但这些若是 IDE 缓存性质（.vs 的 .git 索引、.idea 的
 * workspace.xml）则放进来，因为它们体积大且永远不该被 agent 搜。
 *
 * 与原 grepTool.ts 的 SKIP_DIRS 对齐并扩充：
 * - VCS：node_modules 已含；补充 .svn/.hg/.bzr/.jj
 * - JVM/.NET 构建：target / bin / obj / .gradle / .mvn（Java/Maven 项目卡死根因）
 * - JS 框架构建：dist / build / out / .next / .nuxt / .output / .turbo / .parcel-cache
 * - Python 缓存：__pycache__ / .pytest_cache / .mypy_cache / .ruff_cache
 * - 测试覆盖率 / 通用缓存：coverage / .nyc_output / .cache / .nova
 */
export const BUILD_SKIP_DIRS: ReadonlySet<string> = new Set([
  // 依赖目录
  'node_modules', 'bower_components', '.pnpm-store', 'vendor',
  // VCS
  '.git', '.svn', '.hg', '.bzr', '.jj',
  // JVM / .NET 构建产物（本次卡死的直接根因：target/）
  'target', 'bin', 'obj', '.gradle', '.mvn',
  // JS 框架构建产物
  'dist', 'build', 'out', '.next', '.nuxt', '.output', '.turbo', '.parcel-cache',
  // Python 缓存
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  // 测试覆盖率 / 通用缓存
  'coverage', '.nyc_output', '.cache', '.nova'
])

/** gitignore 匹配器类型（relPath 相对于 workspaceRoot，正斜杠） */
export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean

/**
 * 快速判断单个 entry 名称是否命中硬编码排除集或隐藏目录。
 *
 * find / ls 遍历时对每个 entry 调用一次。隐藏目录（. 开头）默认跳过，
 * 与原 findTool / grepTool 的 `name.startsWith('.')` 行为一致。
 *
 * 注意：ls 是单层列目录，调用方需自行决定是否对"列出的目录名本身"应用此过滤——
 * ls 应该照常显示 target/ 这个目录条目（让模型知道它存在），只是不会递归进去。
 * find 是递归遍历，对每个 entry 都应用此过滤以避免进入 target/ 内部。
 */
export function isPathSkipped(name: string): boolean {
  if (!name) return false
  if (name.startsWith('.')) return true
  return BUILD_SKIP_DIRS.has(name)
}

/**
 * 第 2 层：加载工作区根目录的 .gitignore 并编译匹配器。
 *
 * 返回的 shouldIgnore 函数遵循 git 的"最后匹配规则生效"语义：
 * - `!pattern` 是取反模式，会覆盖之前的 ignore 判定
 * - 目录模式（如 `dist/`）会通过祖先继承作用于其下所有文件
 * - 文件不存在或解析失败时返回"永不忽略"的空匹配器
 *
 * 这是简化版解析：不支持 `[abc]` 字符类、`\#` 转义、双星 `**` 的复杂路径匹配。
 * 覆盖 95%+ 常见 .gitignore 模式；fail-open（不识别就放行）保证不影响主流程。
 *
 * 实现从 grepTool.ts:553 原样搬运，行为零变化（T4 让 grep 改为 import 本函数）。
 */
export async function loadIgnoreMatcher(workspaceRoot: string): Promise<IgnoreMatcher> {
  interface CompiledRule {
    negated: boolean
    match: (candidate: string) => boolean
  }
  const rules: CompiledRule[] = []

  let content: string
  try {
    content = await readFileAsync(join(workspaceRoot, '.gitignore'), 'utf-8')
  } catch {
    // .gitignore 不存在或不可读 → 永不忽略
    return () => false
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const negated = trimmed.startsWith('!')
    const body = negated ? trimmed.slice(1).trim() : trimmed
    // 去掉末尾的目录指示符 /
    const cleaned = body.endsWith('/') ? body.slice(0, -1) : body
    if (!cleaned) continue

    try {
      const matcher = picomatch(cleaned, { dot: true })
      rules.push({ negated, match: (candidate) => matcher(candidate) })
    } catch {
      // 模式不合法，跳过该行（fail-open）
    }
  }

  if (rules.length === 0) return () => false

  return (relPath: string, _isDir: boolean): boolean => {
    if (!relPath) return false
    // 候选路径 = 路径自身 + 每个祖先目录
    // 例如 "dist/build/foo.ts" → ["dist", "dist/build", "dist/build/foo.ts"]
    // 这样 "dist" 模式能匹配到 dist 下的所有文件
    const parts = relPath.split('/')
    const candidates: string[] = []
    for (let i = 1; i <= parts.length; i++) {
      candidates.push(parts.slice(0, i).join('/'))
    }

    let ignored = false
    for (const rule of rules) {
      for (const candidate of candidates) {
        if (rule.match(candidate)) {
          ignored = !rule.negated
          break
        }
      }
    }
    return ignored
  }
}
