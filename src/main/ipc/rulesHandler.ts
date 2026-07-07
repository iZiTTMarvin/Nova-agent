/**
 * Rules 文件读写 IPC — 路径校验防止越界写入
 */
import { existsSync } from 'fs'
import { join, normalize } from 'path'
import { handle } from './secureIpc'
import { RULES_LIST, RULES_READ, RULES_WRITE, RULES_CREATE } from '../../shared/ipc/channels'
import {
  listRuleFiles,
  readRuleFile,
  writeRuleFile,
  isPathInsideRoot,
  buildNewGlobalRulePath,
  buildNewWorkspaceRulePath
} from '../../runtime/agent'
import { getNovaHomeDir } from '../../runtime/settings/novaSettings'
import type {
  RuleFileEntry,
  RulesListParams,
  RulesReadParams,
  RulesWriteParams,
  RulesCreateParams
} from '../../shared/settings/types'

const WORKSPACE_ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'] as const

/** 判断规则路径是否允许读写 */
function assertRulePathAllowed(absolutePath: string, workspaceRoot?: string | null): void {
  const novaHome = getNovaHomeDir()

  // 全局 ~/.nova/rules
  if (isPathInsideRoot(absolutePath, join(novaHome, 'rules'))) {
    return
  }

  // 工作区 .nova/rules
  if (workspaceRoot && isPathInsideRoot(absolutePath, join(workspaceRoot, '.nova', 'rules'))) {
    return
  }

  // 工作区根目录经典规则文件
  if (workspaceRoot) {
    const normalizedTarget = normalize(absolutePath)
    for (const file of WORKSPACE_ROOT_FILES) {
      if (normalizedTarget === normalize(join(workspaceRoot, file))) {
        return
      }
    }
  }

  throw new Error('不允许访问该规则路径')
}

export function registerRulesHandler(): void {
  handle(RULES_LIST, async (_event, params: RulesListParams = {}): Promise<RuleFileEntry[]> => {
    return listRuleFiles(params.workspaceRoot)
  })

  handle(RULES_READ, async (_event, params: RulesReadParams): Promise<string> => {
    assertRulePathAllowed(params.absolutePath, params.workspaceRoot)
    if (!existsSync(params.absolutePath)) {
      throw new Error('规则文件不存在')
    }
    return readRuleFile(params.absolutePath)
  })

  handle(RULES_WRITE, async (_event, params: RulesWriteParams): Promise<void> => {
    assertRulePathAllowed(params.absolutePath, params.workspaceRoot)
    writeRuleFile(params.absolutePath, params.content)
  })

  handle(RULES_CREATE, async (_event, params: RulesCreateParams): Promise<RuleFileEntry> => {
    const content = params.content ?? `# ${params.name}\n\n`
    let absolutePath: string
    if (params.scope === 'global') {
      absolutePath = buildNewGlobalRulePath(params.name)
    } else {
      if (!params.workspaceRoot) {
        throw new Error('创建工作区规则需要先打开项目')
      }
      absolutePath = buildNewWorkspaceRulePath(params.workspaceRoot, params.name)
    }
    assertRulePathAllowed(absolutePath, params.workspaceRoot)
    writeRuleFile(absolutePath, content)
    const listed = listRuleFiles(params.workspaceRoot)
    const found = listed.find(e => normalize(e.absolutePath) === normalize(absolutePath))
    if (!found) {
      throw new Error('规则创建后未能索引到文件')
    }
    return found
  })
}
