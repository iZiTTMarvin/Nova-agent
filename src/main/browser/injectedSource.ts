/**
 * 只读取 playwright-core 随包的注入脚本字符串。
 * 不加载、不连接、不运行 Playwright 驱动。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'

const runtimeRequire = createRequire(__filename)
const GENERATED_SOURCE_ASSIGNMENT = /const source\s*=\s*/

let cachedSource: string | undefined

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") {
    throw new Error('Playwright 注入脚本不是字符串字面量')
  }
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === quote) return index + 1
  }
  throw new Error('Playwright 注入脚本字符串没有结束')
}

export function getPlaywrightInjectedScriptSource(): string {
  if (cachedSource) return cachedSource
  const packageJsonPath = runtimeRequire.resolve('playwright-core/package.json')
  const generatedSourcePath = join(dirname(packageJsonPath), 'lib', 'generated', 'injectedScriptSource.js')
  const generatedModule = readFileSync(generatedSourcePath, 'utf8')
  const assignment = GENERATED_SOURCE_ASSIGNMENT.exec(generatedModule)
  if (!assignment) {
    throw new Error('找不到 Playwright 注入脚本赋值')
  }
  const literalStart = assignment.index + assignment[0].length
  const literalEnd = readStringLiteralEnd(generatedModule, literalStart)
  const decoded: unknown = runInNewContext(generatedModule.slice(literalStart, literalEnd), Object.create(null), {
    timeout: 1_000
  })
  if (
    typeof decoded !== 'string'
    || !decoded.includes('module.exports = __toCommonJS(injectedScript_exports)')
    || !decoded.includes('incrementalAriaSnapshot')
  ) {
    throw new Error('Playwright 注入脚本未通过完整性检查')
  }
  cachedSource = decoded
  return decoded
}
