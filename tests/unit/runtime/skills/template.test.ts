import { describe, it, expect } from 'vitest'
import { expandTemplate } from '../../../../src/runtime/skills/template'

describe('expandTemplate', () => {
  it('替换 <%= key %> 上下文键', () => {
    const { content } = expandTemplate('Workspace: <%= workspacePath %>', {
      workspacePath: '/proj'
    })
    expect(content).toContain('/proj')
  })

  it('未知 ERB 键保留原样并 warn', () => {
    const { content, warnings } = expandTemplate('<%= unknown %>', {})
    expect(content).toContain('<%= unknown %>')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('替换已存在的 ENV 变量', () => {
    const key = 'NOVA_TEST_TEMPLATE_ENV'
    process.env[key] = 'hello-env'
    const { content } = expandTemplate(`Value: \${${key}}`, {})
    expect(content).toContain('hello-env')
    delete process.env[key]
  })

  it('缺失 ENV 保留字面量', () => {
    const { content } = expandTemplate('${DEFINITELY_MISSING_ENV_XYZ}', {})
    expect(content).toBe('${DEFINITELY_MISSING_ENV_XYZ}')
  })

  it('!`shell` 产生 v1 未启用警告', () => {
    const body = 'Run !`git status`'
    const { warnings } = expandTemplate(body, {})
    expect(warnings.some(w => w.includes('shell'))).toBe(true)
  })

  it('${NOVA_*} 引用追加环境提示', () => {
    const { content } = expandTemplate('Use ${NOVA_API_KEY}', {})
    expect(content).toContain('NOVA_API_KEY')
    expect(content).toContain('环境提示')
  })

  it('替换 $ARGUMENTS', () => {
    const { content } = expandTemplate('Args: $ARGUMENTS', { arguments: 'foo bar' })
    expect(content).toContain('foo bar')
  })
})
