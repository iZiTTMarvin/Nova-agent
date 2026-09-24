/**
 * 工作区文件搜索：@ 引用候选的排序与来源降级。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { searchWorkspaceFiles } from '../../../../src/main/services/fileSearchService'
import { extractFileReferences, buildFileReferencePrefix } from '../../../../src/shared/chat/fileReferences'

describe('extractFileReferences', () => {
  it('提取 @路径 引用；邮箱与普通 @ 提及不误报', () => {
    const text = '看一下 @src/agent/loop.ts 和 @docs/方案.md，联系方式 user@example.com 不是引用，@所有人 也不是'
    expect(extractFileReferences(text)).toEqual(['src/agent/loop.ts', 'docs/方案.md'])
  })

  it('重复引用去重；无引用返回空', () => {
    expect(extractFileReferences('@a.ts 和 @a.ts')).toEqual(['a.ts'])
    expect(extractFileReferences('普通消息没有引用')).toEqual([])
  })

  it('提示行包含全部引用与读取指引', () => {
    const prefix = buildFileReferencePrefix(['a.ts', 'b.md'])
    expect(prefix).toContain('a.ts、b.md')
    expect(prefix).toContain('read')
  })
})

describe('searchWorkspaceFiles（非 git 降级）', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-file-search-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'some-pkg'), { recursive: true })
    writeFileSync(join(root, 'src', 'agent.ts'), 'x')
    writeFileSync(join(root, 'src', 'utils.ts'), 'x')
    writeFileSync(join(root, 'docs', 'guide.md'), 'x')
    writeFileSync(join(root, 'README.md'), 'x')
    writeFileSync(join(root, 'node_modules', 'some-pkg', 'index.js'), 'x')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('非 git 目录降级为有界递归，跳过 node_modules', async () => {
    const result = await searchWorkspaceFiles(root, '')
    expect(result.source).toBe('recursive')
    expect(result.files).toContain('src/agent.ts')
    expect(result.files.some(f => f.includes('node_modules'))).toBe(false)
  })

  it('前缀命中优先于子串命中', async () => {
    const result = await searchWorkspaceFiles(root, 's')
    expect(result.files.length).toBeGreaterThan(0)
    const first = result.files[0]
    expect(first.toLowerCase().startsWith('s')).toBe(true)
  })

  it('命中文件名片段也能召回（子串）', async () => {
    const result = await searchWorkspaceFiles(root, 'guide')
    expect(result.files).toContain('docs/guide.md')
  })

  it('无命中返回空列表', async () => {
    const result = await searchWorkspaceFiles(root, 'zzz-not-exist')
    expect(result.files).toEqual([])
  })
})
