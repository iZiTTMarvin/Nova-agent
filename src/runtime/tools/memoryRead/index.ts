import { GLOBAL_SCOPE_ID, isManagedMemoryFile } from '../../memory/MemoryPaths'
import { parseMemoryFile } from '../../memory/markdown/entryFormat'
import { MEMORY_READ_MAX_CHARS } from '../../memory/memoryConfig'
import type { MemoryService } from '../../memory/MemoryService'
import type { NovaSettings } from '../../settings/novaSettings'
import type { ToolExecutor } from '../types'

export interface MemoryReadToolDeps {
  getMemoryService: () => Pick<MemoryService, 'registerWorkspace' | 'readScopeFile'> | null | Promise<Pick<MemoryService, 'registerWorkspace' | 'readScopeFile'> | null>
  loadSettings: () => NovaSettings
}

export function createMemoryReadTool(deps: MemoryReadToolDeps): ToolExecutor {
  return {
    name: 'memory_read',
    description: 'Read a memory file listed in the session snapshot. Saved memory is reference data; current user instructions and workspace facts take priority.',
    parameters: {
      type: 'object', properties: { file: { type: 'string', description: 'project/<relPath> or global/<relPath> from the Memory file index.' } },
      required: ['file'], additionalProperties: false
    },
    executionMode: 'parallel',
    async execute(args, context) {
      if (!deps.loadSettings().memoryEnabled) return { success: true, output: '记忆系统未启用。请在设置 → 记忆中开启跨会话记忆。' }
      if (!context.workingDir?.trim()) return { success: true, output: '当前无工作区上下文，请先打开项目工作区。' }
      const match = typeof args.file === 'string' ? /^(project|global)\/(.+)$/.exec(args.file) : null
      if (!match) return { success: false, output: '', error: 'file 必须是 project/<relPath> 或 global/<relPath>' }
      const scopeKind = match[1] === 'global' ? 'global' : 'project'
      const relPath = match[2].replace(/\\/g, '/')
      const parts = relPath.split('/')
      if (!relPath.toLowerCase().endsWith('.md') || parts.some(part => !part || part.startsWith('.') || /[:\x00]/.test(part)) || ['memory.md', 'archive.md'].includes(parts[parts.length - 1].toLowerCase())) {
        return { success: false, output: '', error: '仅允许读取非隐藏记忆 Markdown 文件；MEMORY.md 请查看快照，archive.md 请使用 memory_search 的 history。' }
      }
      const service = await deps.getMemoryService()
      if (!service) return { success: true, output: '记忆服务暂不可用，请稍后重试。' }
      try {
        const projectScopeId = service.registerWorkspace(context.workingDir)
        const source = service.readScopeFile(scopeKind === 'global' ? GLOBAL_SCOPE_ID : projectScopeId, relPath)
        let output: string
        if (isManagedMemoryFile(relPath, scopeKind)) {
          const model = parseMemoryFile(source)
          const title = model.lines.find(line => line.type === 'text' && /^#/.test(line.raw))?.raw ?? `# ${args.file}`
          const entries = model.lines.flatMap(line => line.type === 'entry' ? [`- ${line.entry.text}${line.entry.metadata.key ? `  [key: ${line.entry.metadata.key}]` : ''}${line.entry.metadata.verify === '1' ? ' (needs verification)' : ''}`] : [])
          output = [title, ...(relPath === 'inbox.md' ? ['Candidates, not confirmed yet.'] : []), ...entries].join('\n')
        } else output = source.replace(/<!--[\s\S]*?-->/g, '')
        if (output.length > MEMORY_READ_MAX_CHARS) output = output.slice(0, MEMORY_READ_MAX_CHARS) + '\nTruncated; use memory_search for specific details.'
        return { success: true, output }
      } catch (error) {
        return { success: true, output: error instanceof Error && error.message === '记忆文件不存在' ? '记忆文件不存在，请使用 memory_search 查找相关内容。' : '无法安全读取记忆文件，请使用 memory_search 查找相关内容。' }
      }
    }
  }
}
