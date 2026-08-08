import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IMPORT_BOUNDARY_ALLOWLIST } from './importBoundaryAllowlist'
import {
  buildViolationsForEdge,
  formatReconcileFailure,
  formatViolation,
  layerCannotImportRule,
  layerOf,
  reconcileBoundaryDebts,
  RULE_RUNTIME_RUN_WORKFLOW,
  RULE_WORKFLOW_HOST_CANNOT_IMPORT_DEFINITIONS,
  RULE_WORKFLOW_DEFINITIONS_CANNOT_IMPORT_ORCHESTRATOR,
  RULE_WORKFLOW_EFFECTS_CANNOT_IMPORT_WORKFLOW,
  RULE_WORKFLOW_SCHEDULING_CANNOT_IMPORT_WORKFLOW,
  RULE_WORKFLOW_STATE_CANNOT_IMPORT_HOST_OR_DEFINITIONS,
  workflowLayerOf,
  RULE_MAIN_SERVICES_CANNOT_IMPORT_IPC,
  RULE_MAIN_AGENT_CANNOT_IMPORT_IPC,
  RULE_AGENT_LOOP_CANNOT_IMPORT_PRODUCT_EXECUTORS,
  RULE_AGENT_CORE_CANNOT_IMPORT_PRODUCT_ROUTING,
  RULE_RUNTIME_CANNOT_IMPORT_ELECTRON,
  toRepoPosixPath,
  type AllowedBoundaryDebt,
  type BoundaryViolation
} from './importBoundaryRules'
import {
  collectViolationsFromSource,
  createFsExists,
  extractModuleSpecifiers,
  findRepoRoot,
  resolveModuleSpecifier,
  scanSourceTree,
  type FileExistsFn
} from './importBoundaryScanner'

function virtualExists(files: Set<string>): FileExistsFn {
  return (repoPath) => files.has(toRepoPosixPath(repoPath))
}

function expectOnlyRule(violations: BoundaryViolation[], rule: string): void {
  expect(violations.map((v) => v.rule)).toEqual([rule])
}

describe('import boundary path helpers', () => {
  it('将 Windows 分隔符规范化为 POSIX 仓库相对路径', () => {
    expect(toRepoPosixPath('src\\runtime\\run\\RunCoordinator.ts')).toBe('src/runtime/run/RunCoordinator.ts')
    expect(toRepoPosixPath('./src/shared/ipc/types.ts')).toBe('src/shared/ipc/types.ts')
  })

  it('正确识别各层与 run/workflow 子树', () => {
    expect(layerOf('src/shared/ipc/types.ts')).toBe('shared')
    expect(layerOf('src/runtime/run/RunCoordinator.ts')).toBe('runtime')
    expect(layerOf('src/renderer/stores/useChatStore.ts')).toBe('renderer')
    expect(layerOf('src/main/ipc/agentHandler.ts')).toBe('main')
    expect(layerOf('src/preload/index.ts')).toBe('preload')
    expect(layerOf('tests/unit/architecture/importBoundaries.test.ts')).toBeNull()
  })
})

describe('import boundary AST extraction', () => {
  it('识别 value import / type-only import / export-from / dynamic import / ImportTypeNode / require', () => {
    const source = `
      import { a } from './value'
      import type { B } from './type-only'
      export { c } from './export-from'
      export type { D } from './export-type-from'
      const mod = await import('./dynamic')
      type T = import('./import-type').T
      const x = require('./require-target')
    `
    const { specifiers, unscannable } = extractModuleSpecifiers(source, 'virtual.ts')
    expect(unscannable).toEqual([])
    expect(specifiers.map((s) => s.specifier).sort()).toEqual([
      './dynamic',
      './export-from',
      './export-type-from',
      './import-type',
      './require-target',
      './type-only',
      './value'
    ])
  })

  it('对非字面量动态 import / require 报告为不可静态验证', () => {
    const source = `
      const name = './x'
      await import(name)
      require(name)
    `
    const { specifiers, unscannable } = extractModuleSpecifiers(source)
    expect(specifiers).toEqual([])
    expect(unscannable).toHaveLength(2)
    expect(unscannable.map((u) => u.kind).sort()).toEqual(['dynamic-import', 'require'])
  })
})

describe('import boundary module resolution', () => {
  const files = new Set([
    'src/shared/a.ts',
    'src/runtime/b.ts',
    'src/runtime/pkg/index.ts',
    'src/renderer/c.tsx',
    'src/renderer/styles.css',
    'src/renderer/styles/theme.js',
    'src/runtime/config.json',
    'src/runtime/guide.md'
  ])
  const exists = virtualExists(files)

  it('解析相对路径、目录 index、路径别名，并统一 POSIX 结果', () => {
    expect(resolveModuleSpecifier('src/shared/a.ts', '../runtime/b', exists)).toEqual({
      kind: 'resolved',
      path: 'src/runtime/b.ts'
    })
    expect(resolveModuleSpecifier('src/shared/a.ts', '../runtime/pkg', exists)).toEqual({
      kind: 'resolved',
      path: 'src/runtime/pkg/index.ts'
    })
    expect(resolveModuleSpecifier('src/shared/a.ts', '@runtime/b', exists)).toEqual({
      kind: 'resolved',
      path: 'src/runtime/b.ts'
    })
    expect(resolveModuleSpecifier('src\\shared\\a.ts', '..\\runtime\\b', exists)).toEqual({
      kind: 'resolved',
      path: 'src/runtime/b.ts'
    })
  })

  it('第三方包保持 external；内部资源与 TS 文件都必须解析到真实仓库路径', () => {
    expect(resolveModuleSpecifier('src/shared/a.ts', 'react', exists)).toEqual({
      kind: 'external',
      specifier: 'react'
    })
    expect(resolveModuleSpecifier('src/shared/a.ts', 'node:fs', exists)).toEqual({
      kind: 'external',
      specifier: 'node:fs'
    })
    expect(resolveModuleSpecifier('src/renderer/c.tsx', './styles.css', exists)).toEqual({
      kind: 'resolved',
      path: 'src/renderer/styles.css'
    })
    const resourceViolation = collectViolationsFromSource({
      fromFile: 'src/shared/a.ts',
      sourceText: "import config from '../runtime/config.json'",
      exists
    })
    expectOnlyRule(resourceViolation.violations, 'shared-cannot-import-runtime')
    const unresolved = resolveModuleSpecifier('src/shared/a.ts', '../runtime/missing', exists)
    expect(unresolved.kind).toBe('unresolved')
  })

  it('生成的 .js 模块按真实文件解析，且仍参与层级判定', () => {
    expect(resolveModuleSpecifier('src/renderer/c.tsx', './styles/theme', exists)).toEqual({
      kind: 'resolved',
      path: 'src/renderer/styles/theme.js'
    })
    const crossLayer = collectViolationsFromSource({
      fromFile: 'src/shared/a.ts',
      sourceText: "import theme from '../renderer/styles/theme'",
      exists
    })
    expectOnlyRule(crossLayer.violations, layerCannotImportRule('shared', 'renderer'))
  })

  it('Vite 查询后缀（?raw 等）剥离后解析到底层真实文件', () => {
    expect(resolveModuleSpecifier('src/shared/a.ts', '../runtime/guide.md?raw', exists)).toEqual({
      kind: 'resolved',
      path: 'src/runtime/guide.md'
    })
  })
})

describe('import boundary layer rules (fixtures)', () => {
  const files = new Set([
    'src/shared/ok.ts',
    'src/shared/bad.ts',
    'src/runtime/target.ts',
    'src/runtime/run/core.ts',
    'src/runtime/workflow/x.ts',
    'src/renderer/ui.ts',
    'src/main/host.ts',
    'src/preload/bridge.ts'
  ])
  const exists = virtualExists(files)

  it('合法同层 / 向下依赖不产生违规', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/main/host.ts',
      sourceText: `
        import { a } from '../runtime/target'
        import type { B } from '@shared/ok'
      `,
      exists
    })
    expect(result.violations).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('value 反向导入失败', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/shared/bad.ts',
      sourceText: `import { t } from '../runtime/target'`,
      exists
    })
    expectOnlyRule(result.violations, layerCannotImportRule('shared', 'runtime'))
  })

  it('type-only 反向导入同样失败', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/renderer/ui.ts',
      sourceText: `import type { T } from '../runtime/target'`,
      exists
    })
    expectOnlyRule(result.violations, layerCannotImportRule('renderer', 'runtime'))
  })

  it('export-from 反向导入失败', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/shared/bad.ts',
      sourceText: `export { t } from '../runtime/target'`,
      exists
    })
    expectOnlyRule(result.violations, layerCannotImportRule('shared', 'runtime'))
  })

  it('dynamic import 反向导入失败', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/target.ts',
      sourceText: `await import('../renderer/ui')`,
      exists
    })
    expectOnlyRule(result.violations, layerCannotImportRule('runtime', 'renderer'))
  })

  it('runtime/run 不能依赖 runtime/workflow', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/run/core.ts',
      sourceText: `import { x } from '../workflow/x'`,
      exists
    })
    expectOnlyRule(result.violations, RULE_RUNTIME_RUN_WORKFLOW)
  })

  it('runtime 不能依赖 Electron API', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/target.ts',
      sourceText: `import type { BrowserWindow } from 'electron'`,
      exists
    })
    expectOnlyRule(result.violations, RULE_RUNTIME_CANNOT_IMPORT_ELECTRON)

    const mainResult = collectViolationsFromSource({
      fromFile: 'src/main/host.ts',
      sourceText: `import { app } from 'electron'`,
      exists
    })
    expect(mainResult.violations).toEqual([])
  })

  it('main/services 不能依赖 main/ipc', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/main/services/WorkspaceService.ts',
      sourceText: `import { x } from '../ipc/agentHandler'`,
      exists: virtualExists(new Set([
        'src/main/services/WorkspaceService.ts',
        'src/main/ipc/agentHandler.ts',
        'src/runtime/target.ts',
        'src/shared/ok.ts',
        'src/renderer/ui.ts',
        'src/runtime/run/core.ts',
        'src/runtime/workflow/x.ts'
      ]))
    })
    expectOnlyRule(result.violations, RULE_MAIN_SERVICES_CANNOT_IMPORT_IPC)
  })

  it('main/agent 不能依赖 main/ipc', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/main/agent/turn/AgentTurnService.ts',
      sourceText: `import { x } from '../../ipc/sessionHandler'`,
      exists: virtualExists(new Set([
        'src/main/agent/turn/AgentTurnService.ts',
        'src/main/ipc/sessionHandler.ts'
      ]))
    })
    expectOnlyRule(result.violations, RULE_MAIN_AGENT_CANNOT_IMPORT_IPC)
  })

  it('AgentLoop 不能直接依赖 skills / workflow 产品执行器', () => {
    const files = virtualExists(new Set([
      'src/runtime/agent/AgentLoop.ts',
      'src/runtime/skills/runSkillFork.ts',
      'src/runtime/workflow/index.ts',
      'src/runtime/agent/turn/resolveAgentTurnRoute.ts'
    ]))
    const skillEdge = collectViolationsFromSource({
      fromFile: 'src/runtime/agent/AgentLoop.ts',
      sourceText: `import { runSkillFork } from '../skills/runSkillFork'`,
      exists: files
    })
    expectOnlyRule(skillEdge.violations, RULE_AGENT_LOOP_CANNOT_IMPORT_PRODUCT_EXECUTORS)

    const workflowEdge = collectViolationsFromSource({
      fromFile: 'src/runtime/agent/AgentLoop.ts',
      sourceText: `import { runWorkflow } from '../workflow'`,
      exists: files
    })
    expectOnlyRule(workflowEdge.violations, RULE_AGENT_LOOP_CANNOT_IMPORT_PRODUCT_EXECUTORS)

    // 路由真源允许复用 invokeSkill：规则只约束 AgentLoop.ts 本身
    const routeEdge = collectViolationsFromSource({
      fromFile: 'src/runtime/agent/turn/resolveAgentTurnRoute.ts',
      sourceText: `import { runSkillFork } from '../../skills/runSkillFork'`,
      exists: files
    })
    expect(routeEdge.violations).toEqual([])
  })

  it('Agent core 不能依赖产品路由或执行器', () => {
    const files = virtualExists(new Set([
      'src/runtime/agent/core/runAgentLoop.ts',
      'src/runtime/agent/turn/TurnDispatcher.ts',
      'src/runtime/skills/runSkillFork.ts',
      'src/runtime/workflow/index.ts'
    ]))
    const cases = [
      `import { TurnDispatcher } from '../turn/TurnDispatcher'`,
      `import { runSkillFork } from '../../skills/runSkillFork'`,
      `import { runWorkflow } from '../../workflow'`
    ]

    for (const sourceText of cases) {
      const result = collectViolationsFromSource({
        fromFile: 'src/runtime/agent/core/runAgentLoop.ts',
        sourceText,
        exists: files
      })
      expectOnlyRule(result.violations, RULE_AGENT_CORE_CANNOT_IMPORT_PRODUCT_ROUTING)
    }
  })

  it('别名路径与 Windows 风格 from 路径得到同一规则结果', () => {
    const unix = collectViolationsFromSource({
      fromFile: 'src/shared/bad.ts',
      sourceText: `import type { T } from '@runtime/target'`,
      exists
    })
    const windows = collectViolationsFromSource({
      fromFile: 'src\\shared\\bad.ts',
      sourceText: `import type { T } from '@runtime/target'`,
      exists
    })
    expect(unix.violations).toEqual(windows.violations)
    expectOnlyRule(unix.violations, layerCannotImportRule('shared', 'runtime'))
  })
})

describe('import boundary allowlist reconciliation', () => {
  const debt: AllowedBoundaryDebt = {
    from: 'src/shared/a.ts',
    to: 'src/runtime/b.ts',
    rule: 'shared-cannot-import-runtime',
    reason: 'fixture: shared 应持有该 DTO，不再从 runtime 再导出'
  }

  it('精确 allowlist 命中时通过', () => {
    const found = buildViolationsForEdge(debt.from, debt.to, '../runtime/b')
    const result = reconcileBoundaryDebts(found, [debt])
    expect(result.unexpected).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('新增违规不在 allowlist 时失败', () => {
    const found = buildViolationsForEdge(
      'src/shared/new.ts',
      'src/runtime/b.ts',
      '../runtime/b'
    )
    const result = reconcileBoundaryDebts(found, [debt])
    expect(result.unexpected).toHaveLength(1)
    expect(formatViolation(result.unexpected[0]!)).toContain('src/shared/new.ts -> src/runtime/b.ts')
  })

  it('债务已消失但 allowlist 未删时失败', () => {
    const result = reconcileBoundaryDebts([], [debt])
    expect(result.stale).toEqual([debt])
  })

  it('禁止靠数量相等掩盖一进一出', () => {
    const incoming = buildViolationsForEdge(
      'src/shared/new.ts',
      'src/runtime/b.ts',
      '../runtime/b'
    )
    const result = reconcileBoundaryDebts(incoming, [debt])
    expect(result.unexpected).toHaveLength(1)
    expect(result.stale).toHaveLength(1)
  })
})

describe('import boundary production gate', () => {
  it('shared/subagents 实际源码不依赖 runtime、main、preload 或 renderer', () => {
    const repoRoot = findRepoRoot(path.resolve(import.meta.dirname, '../../..'))
    const scan = scanSourceTree(repoRoot)
    const subagentViolations = scan.violations.filter((violation) =>
      violation.from.startsWith('src/shared/subagents/')
    )

    expect(subagentViolations).toEqual([])
  })

  it('真实 src 扫描结果与精确 allowlist 双向一致', () => {
    const repoRoot = findRepoRoot(path.resolve(import.meta.dirname, '../../..'))
    const scan = scanSourceTree(repoRoot)

    expect(scan.fileCount).toBeGreaterThan(100)
    expect(scan.unscannable, JSON.stringify(scan.unscannable, null, 2)).toEqual([])
    expect(scan.unresolved, JSON.stringify(scan.unresolved, null, 2)).toEqual([])

    for (const entry of IMPORT_BOUNDARY_ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      expect(entry.reason.toLowerCase()).not.toMatch(/^(legacy|暂时|temp|todo)\b/)
      // reason 写给后续维护者看：禁止方案任务编号（如 T3A）或文档章节引用
      expect(entry.reason).not.toMatch(/\bT\d+[A-Z]?\b/)
      expect(entry.reason).not.toMatch(/§|PRD\b/)
      expect(entry.from.includes('*')).toBe(false)
      expect(entry.to.includes('*')).toBe(false)
    }

    const reconcile = reconcileBoundaryDebts(scan.violations, IMPORT_BOUNDARY_ALLOWLIST)
    if (reconcile.unexpected.length > 0 || reconcile.stale.length > 0) {
      expect.fail(formatReconcileFailure(reconcile))
    }
  })
})

describe('编排内部分层边界（workflow/）', () => {
  const WORKFLOW_FILES = new Set([
    'src/runtime/workflow/types.ts',
    'src/runtime/workflow/orchestrator/WorkflowOrchestrator.ts',
    'src/runtime/workflow/definitions/compose/implement.ts',
    'src/runtime/workflow/host/agentFn.ts',
    'src/runtime/workflow/host/types.ts',
    'src/runtime/workflow/scheduling/TaskScope.ts',
    'src/runtime/workflow/scheduling/semaphore.ts',
    'src/runtime/workflow/effects/fileEffect.ts',
    'src/runtime/workflow/effects/pathSafety.ts',
    'src/runtime/workflow/state/journal.ts',
    'src/runtime/workflow/state/paths.ts',
    'src/runtime/storage/atomicFile.ts'
  ])
  const exists = virtualExists(WORKFLOW_FILES)

  it('识别 workflow 内部层级，非分层目录返回 null', () => {
    expect(workflowLayerOf('src/runtime/workflow/host/agentFn.ts')).toBe('host')
    expect(workflowLayerOf('src/runtime/workflow/effects/fileEffect.ts')).toBe('effects')
    expect(workflowLayerOf('src/runtime/workflow/definitions/compose/implement.ts'))
      .toBe('definitions')
    expect(workflowLayerOf('src/runtime/workflow/types.ts')).toBeNull()
    expect(workflowLayerOf('src/runtime/run/RunCoordinator.ts')).toBeNull()
  })

  it('真实 effects 依赖图无循环', () => {
    const repoRoot = findRepoRoot()
    const effectsRoot = path.join(repoRoot, 'src', 'runtime', 'workflow', 'effects')
    const files = fs.readdirSync(effectsRoot)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `src/runtime/workflow/effects/${name}`)
      .sort()
    const effectFiles = new Set(files)
    const exists = createFsExists(repoRoot)
    const graph = new Map<string, string[]>()

    for (const from of files) {
      const source = fs.readFileSync(path.join(repoRoot, ...from.split('/')), 'utf8')
      const edges: string[] = []
      for (const { specifier } of extractModuleSpecifiers(source, from).specifiers) {
        const resolved = resolveModuleSpecifier(from, specifier, exists)
        if (resolved.kind === 'resolved' && effectFiles.has(resolved.path)) {
          edges.push(resolved.path)
        }
      }
      graph.set(from, edges)
    }

    const visited = new Set<string>()
    const visiting: string[] = []
    const cycles: string[] = []
    const visit = (node: string): void => {
      if (visited.has(node)) return
      const cycleStart = visiting.indexOf(node)
      if (cycleStart >= 0) {
        cycles.push([...visiting.slice(cycleStart), node].join(' -> '))
        return
      }
      visiting.push(node)
      for (const target of graph.get(node) ?? []) visit(target)
      visiting.pop()
      visited.add(node)
    }
    for (const file of files) visit(file)

    expect(cycles).toEqual([])
  })

  it('host 不得 import definitions', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/host/agentFn.ts',
      sourceText: `import { runImplement } from '../definitions/compose/implement'`,
      exists
    })
    expectOnlyRule(result.violations, RULE_WORKFLOW_HOST_CANNOT_IMPORT_DEFINITIONS)
  })

  it('definitions 不得 import orchestrator', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/definitions/compose/implement.ts',
      sourceText: `import { WorkflowOrchestrator } from '../../orchestrator/WorkflowOrchestrator'`,
      exists
    })
    expectOnlyRule(result.violations, RULE_WORKFLOW_DEFINITIONS_CANNOT_IMPORT_ORCHESTRATOR)
  })

  it('effects 不得 import workflow 下任意其他模块（含根级 types）', () => {
    const toState = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/effects/fileEffect.ts',
      sourceText: `import { runJournalPath } from '../state/paths'`,
      exists
    })
    expectOnlyRule(toState.violations, RULE_WORKFLOW_EFFECTS_CANNOT_IMPORT_WORKFLOW)

    const toRoot = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/effects/fileEffect.ts',
      sourceText: `import type { WorkflowPlan } from '../types'`,
      exists
    })
    expectOnlyRule(toRoot.violations, RULE_WORKFLOW_EFFECTS_CANNOT_IMPORT_WORKFLOW)
  })

  it('effects 内部互相 import 与依赖 workflow 之外的模块均放行', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/effects/fileEffect.ts',
      sourceText: `
        import { assertSafeRelativePath } from './pathSafety'
        import { atomicWriteFileSync } from '../../storage/atomicFile'
      `,
      exists
    })
    expect(result.violations).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  it('scheduling 不得 import workflow 下任意其他模块', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/scheduling/TaskScope.ts',
      sourceText: `import { appendJournalSync } from '../state/journal'`,
      exists
    })
    expectOnlyRule(result.violations, RULE_WORKFLOW_SCHEDULING_CANNOT_IMPORT_WORKFLOW)
  })

  it('scheduling 同层 import 放行', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/scheduling/TaskScope.ts',
      sourceText: `import { makeSemaphore } from './semaphore'`,
      exists
    })
    expect(result.violations).toEqual([])
  })

  it('state 不得 import host 或 definitions', () => {
    const toHost = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/state/journal.ts',
      sourceText: `import type { HostContext } from '../host/types'`,
      exists
    })
    expectOnlyRule(toHost.violations, RULE_WORKFLOW_STATE_CANNOT_IMPORT_HOST_OR_DEFINITIONS)

    const toDefinitions = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/state/journal.ts',
      sourceText: `import { runImplement } from '../definitions/compose/implement'`,
      exists
    })
    expectOnlyRule(
      toDefinitions.violations,
      RULE_WORKFLOW_STATE_CANNOT_IMPORT_HOST_OR_DEFINITIONS
    )
  })

  it('state 依赖根级契约类型与 scheduling 不违规', () => {
    const result = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/state/journal.ts',
      sourceText: `
        import type { WorkflowPlan } from '../types'
        import { TaskScope } from '../scheduling/TaskScope'
      `,
      exists
    })
    expect(result.violations).toEqual([])
  })

  it('type-only 与 dynamic import 同样命中内部分层规则', () => {
    const typeOnly = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/host/agentFn.ts',
      sourceText: `import type { PlanTask } from '../definitions/compose/implement'`,
      exists
    })
    expectOnlyRule(typeOnly.violations, RULE_WORKFLOW_HOST_CANNOT_IMPORT_DEFINITIONS)

    const dynamic = collectViolationsFromSource({
      fromFile: 'src/runtime/workflow/scheduling/semaphore.ts',
      sourceText: `await import('../state/journal')`,
      exists
    })
    expectOnlyRule(dynamic.violations, RULE_WORKFLOW_SCHEDULING_CANNOT_IMPORT_WORKFLOW)
  })
})
