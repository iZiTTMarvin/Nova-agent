/**
 * Skill 正文模板展开（v1 受限）
 * - <%= key %> 从 TemplateContext 取值
 * - ${ENV_VAR} 从 process.env 取值，缺失保留字面
 * - !`shell` v1 不执行，保留原样并追加警告
 */
import type { TemplateContext } from './types'

const ERB_RE = /<%=\s*([\w.]+)\s*%>/g
const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g
const SHELL_INJECT_RE = /!`[^`]+`/g

export interface ExpandTemplateResult {
  content: string
  warnings: string[]
}

function resolveContextKey(ctx: TemplateContext, key: string): string | undefined {
  const value = ctx[key]
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * 展开 skill 正文模板
 */
export function expandTemplate(body: string, ctx: TemplateContext = {}): ExpandTemplateResult {
  const warnings: string[] = []
  let content = body

  // ERB 风格占位符
  content = content.replace(ERB_RE, (_match, key: string) => {
    const resolved = resolveContextKey(ctx, key)
    if (resolved === undefined) {
      warnings.push(`模板键 "<%= ${key} %>" 无对应上下文值，保留原样`)
      return _match
    }
    return resolved
  })

  // 环境变量
  content = content.replace(ENV_RE, (match, envKey: string) => {
    const envValue = process.env[envKey]
    if (envValue === undefined) return match
    return envValue
  })

  // v1 不执行 shell 注入
  if (SHELL_INJECT_RE.test(body)) {
    warnings.push('检测到 !`shell` 动态注入，v1 未启用执行，已保留字面量')
  }

  // NOVA_* 环境变量引用提示
  const novaEnvRefs = [...body.matchAll(/\$\{(NOVA_[A-Z0-9_]+)\}/g)].map(m => m[1])
  if (novaEnvRefs.length > 0) {
    const unique = [...new Set(novaEnvRefs)]
    content += `\n\n<!-- Nova 环境提示：本 skill 引用了 ${unique.join(', ')}，请确保已在系统或 .env 中配置。 -->`
  }

  // $ARGUMENTS / $0 等 Claude 占位符（v1 简单替换）
  if (ctx.arguments !== undefined) {
    content = content
      .replace(/\$ARGUMENTS\b/g, ctx.arguments)
      .replace(/\$0\b/g, ctx.arguments.split(/\s+/)[0] ?? '')
      .replace(/\$1\b/g, ctx.arguments.split(/\s+/)[1] ?? '')
  }

  return { content, warnings }
}
