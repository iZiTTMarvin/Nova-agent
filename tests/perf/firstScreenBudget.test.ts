/**
 * 首屏体积 budget 门禁
 *
 * 保护对象：renderer 首屏必须同步加载的字节数。它由 index.html 里的
 * module script 与 stylesheet 决定，并沿 vite manifest 的**静态** imports 闭包求和
 * （不跟 dynamicImports —— 动态 chunk 不属于首屏）。
 *
 * 与 rendererPerfHarness.test.ts 的分工：那套管运行时 commit/longtask/heap 预算，
 * 本套管构建产物的首屏字节上限。两者都是「性能不靠自觉」的护栏。
 *
 * 跳过条件（必须显式，不能静默通过）：
 * - 没有构建产物：CI 中 `npm test` 早于 `npm run build`，全新 checkout 无 out/。
 * - 产物陈旧：任一源文件比 index.html 新，测到的是上一次构建的假数字。
 * 两种情况都用 it.skip 并打印原因，让报告里看得到「本轮没测」而不是「测过了」。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '../..')
const rendererOut = join(repoRoot, 'out/renderer')
const indexHtml = join(rendererOut, 'index.html')
const manifestFile = join(rendererOut, '.vite/manifest.json')

/**
 * 预算上限（KB，未压缩产物字节）。
 *
 * 口径是 **首屏 JS + CSS 合计**。各阶段实测基线：
 * - 未开压缩：3954 KB（entry JS 3532 + CSS 422）
 * - P0 开 minify：2054.6 KB
 * - P1a 移出 diff/高亮/worker 池：1564.5 KB
 * - P1b 设置面板按需加载：1445.4 KB
 *
 * P1c（浏览器 / 学习表面 / 审阅面板按需加载）已实施后回退：这三处与
 * BrowserGuestLayer / 布局测量存在隐式握手，懒加载会让 <webview> 定尺寸 effect
 * 不重跑、split 判定改变，实测导致 29 个浏览器 E2E 用例失败。
 * 详见 src/renderer/features/browser/BrowserWorkspaceBody.tsx 顶部说明。
 * 若将来要重新做，必须先给这些契约补「就绪」信号，而不是直接 lazy。
 *
 * 当前留约 3% 余量给依赖补丁的小幅浮动。
 */
const BUDGET_KB = Number(process.env.NOVA_BUNDLE_ENTRY_KB ?? 1495)

interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

type Manifest = Record<string, ManifestChunk>

function readManifest(): Manifest | null {
  if (!existsSync(manifestFile)) return null
  try {
    return JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest
  } catch {
    return null
  }
}

/** 取 index.html 直接引用的 module script 与 stylesheet 路径（相对 rendererOut） */
function readHtmlEntryAssets(html: string): string[] {
  const assets: string[] = []
  const scriptRe = /<script[^>]*\btype="module"[^>]*\bsrc="\.\/([^"]+\.js)"/g
  const linkRe = /<link[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^"]+\.css)"/g
  for (const re of [scriptRe, linkRe]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(html)) !== null) assets.push(match[1])
  }
  return assets
}

function fileSizeKb(relPath: string): number {
  const abs = join(rendererOut, relPath)
  if (!existsSync(abs)) return 0
  return statSync(abs).size / 1024
}

/**
 * 沿 manifest 的静态 imports 闭包求和。
 * 只跟 imports：被 entry 静态 import 的 chunk 一定会阻塞首屏渲染；
 * dynamicImports 由运行时按需发起，不计入首屏字节。
 */
function sumStaticClosure(entryKey: string, manifest: Manifest): number | null {
  const seen = new Set<string>()
  const stack = [entryKey]
  let total = 0

  while (stack.length > 0) {
    const key = stack.pop() as string
    if (seen.has(key)) continue
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) continue
    total += fileSizeKb(chunk.file)
    for (const css of chunk.css ?? []) total += fileSizeKb(css)
    for (const dep of chunk.imports ?? []) stack.push(dep)
  }
  return total
}

function newestSourceMtimeMs(): number {
  const roots = [
    join(repoRoot, 'src/renderer'),
    join(repoRoot, 'src/shared')
  ]
  const files = [join(repoRoot, 'electron.vite.config.ts')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) walk(abs)
        else if (/\.(ts|tsx|css|html)$/.test(entry.name)) files.push(abs)
      }
    }
    walk(root)
  }
  let newest = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    const m = statSync(file).mtimeMs
    if (m > newest) newest = m
  }
  return newest
}

type SkipReason = 'no-build' | 'stale-build' | null

function detectSkipReason(): SkipReason {
  if (!existsSync(indexHtml)) return 'no-build'
  const builtAt = statSync(indexHtml).mtimeMs
  if (newestSourceMtimeMs() > builtAt) return 'stale-build'
  return null
}

const skipReason = detectSkipReason()

describe('首屏体积 budget', () => {
  it.skipIf(skipReason !== null)(
    'entry 静态闭包不超过预算',
    () => {
      const html = readFileSync(indexHtml, 'utf8')
      const manifest = readManifest()

      let entryKey: string | undefined
      if (manifest) {
        entryKey = Object.keys(manifest).find(
          (key) => manifest[key].isEntry && manifest[key].file.endsWith('.js')
        )
      }

      const closureKb = entryKey && manifest ? sumStaticClosure(entryKey, manifest) : null
      const fallbackKb = readHtmlEntryAssets(html).reduce((sum, p) => sum + fileSizeKb(p), 0)

      const measuredKb = closureKb ?? fallbackKb
      const method = closureKb !== null ? 'manifest 静态闭包' : 'index.html 直接引用'

      // 兜底自检：任何一种口径都不该量到 0，否则门禁会假绿
      expect(measuredKb).toBeGreaterThan(0)

      console.info(
        `[first-screen-budget] ${method}：${measuredKb.toFixed(1)} KB / 预算 ${BUDGET_KB} KB`
      )
      expect(
        measuredKb,
        `首屏体积超预算（${method} ${measuredKb.toFixed(1)} KB > ${BUDGET_KB} KB）。` +
          `若是有意引入的新首屏依赖，请同时上调 NOVA_BUNDLE_ENTRY_KB 并说明理由。`
      ).toBeLessThanOrEqual(BUDGET_KB)
    }
  )

  it('skip 判定本身正确：无产物或陈旧产物时给出明确原因', () => {
    // 防止「门禁永远在跳过」这种假绿被当成通过
    if (skipReason === 'no-build') {
      expect(existsSync(indexHtml)).toBe(false)
      console.info('[first-screen-budget] 跳过：没有构建产物（需先 npm run build）')
    } else if (skipReason === 'stale-build') {
      expect(statSync(indexHtml).mtimeMs).toBeLessThan(newestSourceMtimeMs())
      console.info('[first-screen-budget] 跳过：构建产物早于源文件（需重新 npm run build）')
    } else {
      expect(skipReason).toBeNull()
    }
  })
})
