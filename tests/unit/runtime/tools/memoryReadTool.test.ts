import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryReadTool } from '../../../../src/runtime/tools/memoryRead'
import { MemoryService } from '../../../../src/runtime/memory/MemoryService'
import { MemoryScopeDirectoryResolver } from '../../../../src/runtime/memory/MemoryPaths'
import { MEMORY_FILE_HEADER, serializeMemoryEntryLine } from '../../../../src/runtime/memory/markdown/entryFormat'
import { MEMORY_READ_MAX_CHARS } from '../../../../src/runtime/memory/memoryConfig'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { createReadState } from '../../../../src/runtime/tools/editTool'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nova-memory-read-')); roots.push(root)
  const memoryRoot = join(root, 'memory'), workspace = join(root, 'workspace')
  const service = new MemoryService(memoryRoot)
  const scopeId = service.registerWorkspace(workspace)
  const paths = new MemoryScopeDirectoryResolver(memoryRoot); paths.registerWorkspace(workspace)
  const project = paths.resolve(scopeId), global = paths.resolve('user')
  mkdirSync(project, { recursive: true }); mkdirSync(global, { recursive: true })
  const tool = createMemoryReadTool({ getMemoryService: () => service, loadSettings: () => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }) })
  const context = { workingDir: workspace, readState: createReadState() }
  return { root, project, global, service, tool, context }
}

describe('memory_read', () => {
  it('读取真实主题文件与候选，仅公开正文、key 和待确认说明', async () => {
    const { project, global, tool, context } = setup()
    const source = MEMORY_FILE_HEADER + '\n# Conventions\n' + serializeMemoryEntryLine({ text: '中文发布约定', metadata: { id: 'm_0000000001', by: 'user', added: '2026-10-08', key: 'release', verify: '1', unknown: {} } }) + '\n'
    writeFileSync(join(project, 'conventions.md'), source)
    writeFileSync(join(global, 'inbox.md'), source)
    const result = await tool.execute({ file: 'project/conventions.md' }, context)
    expect(result).toEqual({ success: true, output: '# Conventions\n- 中文发布约定  [key: release] (needs verification)' })
    expect((await tool.execute({ file: 'global/inbox.md' }, context)).output).toContain('Candidates, not confirmed yet.')
    expect(result.output).not.toMatch(/id=|by=|<!--/)
  })

  it('用户文档保留正文，去掉注释，超长文件明确截断；缺失文件降级', async () => {
    const { project, tool, context } = setup()
    writeFileSync(join(project, 'notes.md'), '# Notes\n<!-- private metadata -->\n正文')
    expect((await tool.execute({ file: 'project/notes.md' }, context)).output).toBe('# Notes\n\n正文')
    writeFileSync(join(project, 'large.md'), 'x'.repeat(MEMORY_READ_MAX_CHARS + 5))
    expect((await tool.execute({ file: 'project/large.md' }, context)).output).toBe('x'.repeat(MEMORY_READ_MAX_CHARS) + '\nTruncated; use memory_search for specific details.')
    expect((await tool.execute({ file: 'project/missing.md' }, context))).toMatchObject({ success: true, output: expect.stringContaining('不存在') })
  })

  it('拒绝跨 scope、隐藏文件、生成视图、归档、路径穿越和目录链接', async () => {
    const { root, project, tool, context } = setup()
    for (const file of ['other/notes.md', 'global/../notes.md', 'project/.ledger.md', 'project/.backup/x.md', 'project/MEMORY.md', 'project/archive.md', 'project/C:/outside.md', 'project/notes.txt']) {
      expect((await tool.execute({ file }, context)).success, file).toBe(false)
    }
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.md'), 'outside data')
    symlinkSync(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await tool.execute({ file: 'project/link/secret.md' }, context)).output).toContain('无法安全读取')
  })

  it('关闭记忆、无工作区和服务不可用均为说明性结果', async () => {
    const { tool, context } = setup()
    expect((await tool.execute({ file: 'global/notes.md' }, { ...context, workingDir: '' })).output).toContain('无工作区')
    const disabled = createMemoryReadTool({ getMemoryService: () => { throw new Error('must not read') }, loadSettings: () => DEFAULT_NOVA_SETTINGS })
    expect((await disabled.execute({ file: 'global/notes.md' }, context)).output).toContain('未启用')
    const unavailable = createMemoryReadTool({ getMemoryService: () => null, loadSettings: () => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }) })
    expect((await unavailable.execute({ file: 'global/notes.md' }, context)).output).toContain('暂不可用')
  })
})
