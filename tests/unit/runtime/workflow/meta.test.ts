import { describe, it, expect } from 'vitest'
import { parseMeta } from '../../../../src/runtime/workflow/meta'

describe('workflow meta parser', () => {
  it('解析合法 meta 字面量', () => {
    const script = `
export const meta = {
  name: "demo",
  description: "a demo",
  whenToUse: "test",
  phases: [{ title: "one" }],
};
const x = 1;
`
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.meta.name).toBe('demo')
    expect(parsed.meta.description).toBe('a demo')
    expect(parsed.meta.phases).toEqual([{ title: 'one' }])
    // meta 语句被空白替换，行号保留
    expect(parsed.body).toContain('const x = 1')
    expect(parsed.body).not.toMatch(/export\s+const\s+meta/)
  })

  it('拒绝函数调用', () => {
    const script = `export const meta = { name: evil(), description: "x" };`
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(false)
  })

  it('拒绝属性访问', () => {
    const script = `export const meta = { name: globalThis.process, description: "x" };`
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(false)
  })

  it('拒绝模板字符串', () => {
    const script = 'export const meta = { name: `x`, description: "y" };'
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(false)
  })

  it('拒绝箭头函数', () => {
    const script = `export const meta = { name: (() => "x")(), description: "y" };`
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(false)
  })

  it('拒绝缺 name / description', () => {
    expect(parseMeta(`export const meta = { name: "x" };`).ok).toBe(false)
    expect(parseMeta(`export const meta = { description: "x" };`).ok).toBe(false)
  })

  it('支持单引号字符串与尾逗号', () => {
    const script = `export const meta = { name: 'n', description: 'd', };`
    const parsed = parseMeta(script)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.meta.name).toBe('n')
  })
})
