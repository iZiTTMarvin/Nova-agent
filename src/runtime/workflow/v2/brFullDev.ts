/**
 * br-full-dev Workflow v2：稳定 step ID 的可恢复 DAG。
 * worktree / bash / integrate / agent / write 均为 step；committed 不重复。
 *
 * v2 幂等由 StepEngine 的 stepId+inputHash 保证（step 级跳过）；
 * journal 仅作单 run 内 agent 结果缓存，不承担跨 resume 的副作用去重。
 * 实际副作用（write/bash/worktree/integrate）通过显式传入 StepRunContext
 * 消费 idempotencyKey 写 receipt，实现 at-least-once + handler 去重。
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { createHostHooks, type HookContext } from '../hooks'
import { scriptSha } from '../journal'
import { StepEngine } from './StepEngine'
import type { StepRunContext } from './types'
import type { ComposeState, WorkflowRuntimeDeps } from '../types'
import type { TaskScope } from '../TaskScope'

const DESIGN_SHAPE = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    route: { type: 'string' }
  },
  required: ['title', 'body']
}

const ROUTE_SHAPE = {
  type: 'object',
  properties: {
    route: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['route']
}

const SCOPE_SHAPE = {
  type: 'object',
  properties: {
    highCount: { type: 'number' },
    highs: { type: 'array', items: { type: 'object' } },
    summary: { type: 'string' }
  },
  required: ['highCount']
}

const PLAN_SHAPE = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          size: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
          verify: { type: 'string' }
        },
        required: ['id', 'title']
      }
    }
  },
  required: ['title', 'tasks']
}

const IMPL_SHAPE = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } }
  }
}

const VERIFY_SHAPE = {
  type: 'object',
  properties: {
    allPassed: { type: 'boolean' },
    pass: { type: 'number' },
    fail: { type: 'number' },
    evidence: { type: 'string' }
  },
  required: ['allPassed']
}

const INTEGRATE_SHAPE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' }
  }
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function slug(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'untitled'
}

function isNewProject(r: string): boolean {
  const keywords = ['新项目', '从零', 'new project', '搭建', '初始化项目', '大重构', '重写整个']
  return keywords.some((k) => r.includes(k))
}

export interface BrFullDevV2Args {
  requirement: string
}

export interface BrFullDevV2Context {
  engine: StepEngine
  hooks: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>
  hookCtx: HookContext
  deps: WorkflowRuntimeDeps
  scope: TaskScope
  composeState: ComposeState
  persistState: () => void
  requirement: string
}

/** 通过 host hook 调 agent（已含 journal/scope 校验）；可显式带上 stepCtx */
async function callAgent(
  hooks: BrFullDevV2Context['hooks'],
  prompt: string,
  opts: Record<string, unknown>,
  stepCtx?: StepRunContext
): Promise<unknown> {
  const o = stepCtx ? { ...opts, stepCtx } : opts
  return hooks.agent!(prompt, o)
}

async function callBash(
  hooks: BrFullDevV2Context['hooks'],
  cmd: string,
  stepCtx?: StepRunContext
): Promise<{ exitCode: number; stdout: string; stderr: string; passed: boolean }> {
  return (await hooks.bash!(cmd, stepCtx)) as {
    exitCode: number
    stdout: string
    stderr: string
    passed: boolean
  }
}

/**
 * 注册并跑完 br-full-dev v2 图。
 * 动态任务 step 在 plan 提交后追加。
 */
export async function runBrFullDevV2(ctx: BrFullDevV2Context): Promise<unknown> {
  const { engine, hooks, requirement, composeState, persistState, deps } = ctx
  const workspaceRoot = deps.workspaceRoot

  if (!requirement) {
    return { error: 'no-requirement', message: 'Pass /br-full-dev <需求>' }
  }

  // ── bash: 记录 git baseline（只读幂等，可安全 resume 复用）──
  engine.register({
    id: 'bash:git-baseline',
    kind: 'bash',
    policy: { retryable: true, sideEffect: 'bash', idempotent: true },
    input: { cmd: 'git rev-parse HEAD', phase: 'explore' },
    run: async (sc) => {
      const head = await callBash(hooks, 'git rev-parse HEAD', sc)
      let gitBaseline: string | null = null
      if (head?.passed) {
        const sha = String(head.stdout || '').trim()
        if (/^[0-9a-f]{7,40}$/i.test(sha)) gitBaseline = sha
      }
      // 写入 artifacts，供回滚 UI 使用
      if (gitBaseline) {
        await hooks.updateState!({
          artifacts: { git_baseline: gitBaseline }
        })
      }
      return { gitBaseline }
    }
  })

  engine.register({
    id: 'phase:explore',
    kind: 'phase',
    deps: ['bash:git-baseline'],
    policy: { retryable: true, sideEffect: 'state' },
    input: { phase: '探索' },
    run: async () => {
      await hooks.phase!('探索')
      await hooks.log!('br-full-dev v2 start', { requirement })
      return { phase: 'explore' }
    }
  })

  engine.register({
    id: 'explore:route',
    kind: 'agent',
    deps: ['phase:explore'],
    policy: { retryable: true, sideEffect: 'llm' },
    input: {
      prompt: 'route:' + requirement,
      skill: 'br-idea',
      schema: ROUTE_SHAPE,
      tools: null,
      isolation: null
    },
    run: async () => {
      const ideaRoute = (await callAgent(
        hooks,
        '根据需求分流到 br-office-hours 或 br-brainstorming：' + requirement,
        { skill: 'br-idea', schema: ROUTE_SHAPE, label: 'br-idea' }
      )) as { route?: string; reason?: string } | null

      let routeSkill: string
      let routeReason: string
      if (
        ideaRoute &&
        (ideaRoute.route === 'br-office-hours' || ideaRoute.route === 'br-brainstorming')
      ) {
        routeSkill = ideaRoute.route
        routeReason = ideaRoute.reason || 'br-idea 分流'
      } else {
        routeSkill = isNewProject(requirement) ? 'br-office-hours' : 'br-brainstorming'
        routeReason = isNewProject(requirement)
          ? '脚本快捷判断：新项目/大方向'
          : '脚本快捷判断：小功能增强'
      }
      await hooks.updateState!({
        auto_decisions: [
          { phase: 'explore', decision: '路由到 ' + routeSkill, reason: routeReason, auto: true }
        ]
      })
      return { routeSkill, routeReason }
    }
  })

  engine.register({
    id: 'explore:design',
    kind: 'agent',
    deps: ['explore:route'],
    policy: { retryable: true, sideEffect: 'llm' },
    input: {
      kind: 'design',
      requirement,
      schema: DESIGN_SHAPE
    },
    run: async (sc) => {
      const route = sc.getOutput<{ routeSkill: string }>('explore:route')
      const routeSkill = route?.routeSkill ?? 'br-brainstorming'
      const design = (await callAgent(
        hooks,
        '执行 ' + routeSkill + '，产出设计文档正文。需求：' + requirement,
        { skill: routeSkill, schema: DESIGN_SHAPE, label: 'explore-design' }
      )) as { title?: string; body?: string } | null
      if (!design?.body) {
        throw new Error('brainstorm-failed')
      }
      return design
    }
  })

  engine.register({
    id: 'explore:write-spec',
    kind: 'write',
    deps: ['explore:design'],
    policy: { retryable: true, sideEffect: 'fs' },
    input: { artifact: 'spec' },
    run: async (sc) => {
      const design = sc.getOutput<{ title?: string; body: string }>('explore:design')!
      const designTitle = design.title || requirement.slice(0, 30)
      const specPath =
        '.nova/compose/specs/' + today() + '-' + slug(designTitle) + '-design.md'
      await hooks.write!(specPath, design.body, sc)
      await hooks.updateState!({ artifacts: { spec: specPath } })
      return { specPath, designTitle }
    }
  })

  engine.register({
    id: 'phase:plan',
    kind: 'phase',
    deps: ['explore:write-spec'],
    policy: { retryable: true, sideEffect: 'state' },
    input: { phase: '计划' },
    run: async () => {
      await hooks.phase!('计划')
      return { phase: 'plan' }
    }
  })

  engine.register({
    id: 'plan:scope-check',
    kind: 'agent',
    deps: ['phase:plan'],
    policy: { retryable: true, sideEffect: 'llm' },
    input: { skill: 'br-scope-check', schema: SCOPE_SHAPE },
    run: async (sc) => {
      const { specPath } = sc.getOutput<{ specPath: string }>('explore:write-spec')!
      const route = sc.getOutput<{ routeSkill: string }>('explore:route')
      const routeSkill = route?.routeSkill ?? 'br-brainstorming'
      let scope = (await callAgent(
        hooks,
        '执行 br-scope-check，审查设计文档：' + specPath,
        { skill: 'br-scope-check', schema: SCOPE_SHAPE, label: 'scope-check' }
      )) as { highCount?: number; highs?: unknown[] } | null

      for (let i = 0; i < 2 && scope && (scope.highCount ?? 0) > 0; i++) {
        const fixed = (await callAgent(
          hooks,
          '修复 scope-check 的 HIGH 问题并重写设计文档正文。当前设计路径：' +
            specPath +
            '\nHIGH 问题：' +
            JSON.stringify(scope.highs || []),
          { skill: routeSkill, schema: DESIGN_SHAPE, label: 'scope-fix-' + i }
        )) as { body?: string } | null
        if (!fixed?.body) break
        await hooks.write!(specPath, fixed.body, sc)
        scope = (await callAgent(
          hooks,
          '执行 br-scope-check，审查设计文档：' + specPath,
          { skill: 'br-scope-check', schema: SCOPE_SHAPE, label: 'scope-check-r' + (i + 1) }
        )) as { highCount?: number; highs?: unknown[] } | null
      }
      return { scope }
    }
  })

  engine.register({
    id: 'plan:breakdown',
    kind: 'agent',
    deps: ['plan:scope-check'],
    policy: { retryable: true, sideEffect: 'llm' },
    input: { skill: 'br-task-breakdown', schema: PLAN_SHAPE },
    run: async (sc) => {
      const { specPath, designTitle } = sc.getOutput<{
        specPath: string
        designTitle: string
      }>('explore:write-spec')!
      const plan = (await callAgent(
        hooks,
        '执行 br-task-breakdown，基于设计文档拆分任务：' + specPath,
        { skill: 'br-task-breakdown', schema: PLAN_SHAPE, label: 'task-breakdown' }
      )) as {
        title?: string
        body?: string
        tasks?: Array<{
          id?: string
          title?: string
          size?: string
          deps?: string[]
          verify?: string
        }>
      } | null
      if (!plan?.tasks?.length) throw new Error('plan-failed')
      return { plan, designTitle }
    }
  })

  engine.register({
    id: 'plan:write-plan',
    kind: 'write',
    deps: ['plan:breakdown'],
    policy: { retryable: true, sideEffect: 'fs' },
    input: { artifact: 'plan' },
    run: async (sc) => {
      const { plan, designTitle } = sc.getOutput<{
        plan: { title?: string; body?: string; tasks: Array<Record<string, unknown>> }
        designTitle: string
      }>('plan:breakdown')!
      const planTitle = plan.title || designTitle
      const planPath =
        '.nova/compose/plans/' + today() + '-' + slug(planTitle) + '-plan.md'
      const body = plan.body || JSON.stringify(plan.tasks, null, 2)
      await hooks.write!(planPath, body, sc)
      const tasks = plan.tasks.map((t, i) => ({
        id: String(t.id || 'task-' + String(i + 1).padStart(3, '0')),
        title: String(t.title || 'task-' + (i + 1)),
        size: String(t.size || 'S'),
        deps: Array.isArray(t.deps) ? (t.deps as string[]) : [],
        verifyCriteria: t.verify ? String(t.verify) : '',
        status: 'pending' as const,
        attempts: 0
      }))
      await hooks.updateState!({
        artifacts: { plan: planPath },
        tasks
      })
      return { planPath, tasks }
    }
  })

  // 先跑静态前缀（不 finalize，后续还要注册 execute steps）
  const prefixResult = await engine.runAll({ finalize: false })
  if (prefixResult.status !== 'completed') {
    return { error: prefixResult.error ?? prefixResult.status }
  }

  const planOut = engine.getOutput<{
    planPath: string
    tasks: Array<{
      id: string
      title: string
      verifyCriteria?: string
      deps?: string[]
    }>
  }>('plan:write-plan')
  if (!planOut?.tasks?.length) {
    return { error: 'plan-failed' }
  }

  // ── 执行阶段：每任务 worktree+impl+verify 为独立 step ──
  engine.register({
    id: 'phase:execute',
    kind: 'phase',
    deps: ['plan:write-plan'],
    policy: { retryable: true, sideEffect: 'state' },
    input: { phase: '执行' },
    run: async () => {
      await hooks.phase!('执行')
      return { phase: 'execute' }
    }
  })

  const taskIds: string[] = []
  for (const task of planOut.tasks) {
    const implId = `execute:${task.id}:impl`
    const verifyId = `execute:${task.id}:verify`
    taskIds.push(task.id)

    engine.register({
      id: implId,
      kind: 'worktree',
      deps: ['phase:execute'],
      policy: { retryable: true, sideEffect: 'worktree' },
      input: {
        taskId: task.id,
        title: task.title,
        isolation: 'worktree',
        schema: IMPL_SHAPE,
        skill: 'br-implement'
      },
      run: async (sc) => {
        await hooks.updateState!({
          task: { id: task.id, status: 'in_progress', started_at: new Date().toISOString() }
        })
        const out = await callAgent(
          hooks,
          `实现任务 ${task.id}「${task.title}」。验收：${task.verifyCriteria || '无'}`,
          {
            skill: 'br-implement',
            schema: IMPL_SHAPE,
            isolation: 'worktree',
            label: 'impl-' + task.id
          },
          sc
        )
        return out
      }
    })

    engine.register({
      id: verifyId,
      kind: 'agent',
      deps: [implId],
      policy: { retryable: true, sideEffect: 'llm' },
      input: {
        taskId: task.id,
        skill: 'br-verify',
        schema: VERIFY_SHAPE
      },
      run: async (sc) => {
        const impl = sc.getOutput<Record<string, unknown>>(implId)
        const wt = impl && typeof impl === 'object' ? (impl as { _worktree?: { directory?: string } })._worktree : undefined
        const directory = wt?.directory
        const verify = (await callAgent(
          hooks,
          `验收任务 ${task.id}「${task.title}」。标准：${task.verifyCriteria || '无'}`,
          {
            skill: 'br-verify',
            schema: VERIFY_SHAPE,
            label: 'verify-' + task.id,
            ...(directory ? { directory } : {})
          }
        )) as { allPassed?: boolean; pass?: number; fail?: number; evidence?: string } | null

        const passed = !!verify?.allPassed
        await hooks.updateState!({
          task: {
            id: task.id,
            status: passed ? 'done' : 'failed',
            finished_at: new Date().toISOString(),
            verify: verify
              ? { pass: verify.pass ?? 0, fail: verify.fail ?? 0, evidence: verify.evidence }
              : undefined,
            ...(passed
              ? {}
              : {
                  failure: {
                    reason: 'verify_failed_3x',
                    summary: verify?.evidence || '验收未通过'
                  }
                })
          }
        })
        return { verify, impl, directory }
      }
    })

    engine.register({
      id: `execute:${task.id}:integrate`,
      kind: 'integrate',
      deps: [verifyId],
      // integrate：非幂等；有 receipt 则跳过，中断无 receipt 则 blocked
      policy: { retryable: false, sideEffect: 'integrate', idempotent: false },
      input: { taskId: task.id, schema: INTEGRATE_SHAPE },
      run: async (sc) => {
        const prev = sc.getOutput<{
          verify?: { allPassed?: boolean }
          impl?: { _worktree?: { changed?: boolean; directory?: string; branch?: string } }
        }>(verifyId)
        const wt = prev?.impl && typeof prev.impl === 'object' ? prev.impl._worktree : undefined
        if (!prev?.verify?.allPassed || !wt?.changed) {
          if (wt) await hooks.cleanupWorktree!(wt, sc)
          return { skipped: true }
        }
        const result = await hooks.integrate!(
          '执行 integrate：将以下 worktree 合并到主工作目录。\n' + JSON.stringify([wt]),
          { schema: INTEGRATE_SHAPE, label: 'integrate-' + task.id, stepCtx: sc },
          sc
        )
        await hooks.cleanupWorktree!(wt, sc)
        return { result }
      }
    })
  }

  engine.register({
    id: 'phase:ship',
    kind: 'phase',
    deps: planOut.tasks.map((t) => `execute:${t.id}:integrate`),
    policy: { retryable: true, sideEffect: 'state' },
    input: { phase: '发布', taskIds },
    run: async (sc) => {
      await hooks.phase!('发布')
      const reportPath =
        '.nova/compose/reports/' + today() + '-' + slug(requirement.slice(0, 20)) + '-report.md'
      const abs = join(workspaceRoot, reportPath)
      mkdirSync(dirname(abs), { recursive: true })
      const body =
        `# br-full-dev 报告\n\n需求：${requirement}\n\n` +
        `任务数：${planOut.tasks.length}\n` +
        `完成于：${new Date().toISOString()}\n`
      if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true })
      await hooks.write!(reportPath, body, sc)
      await hooks.updateState!({ artifacts: { report: reportPath } })
      return { reportPath }
    }
  })

  const rest = await engine.runAll()
  if (rest.status !== 'completed') {
    return { error: rest.error ?? rest.status, engine: 'v2' }
  }

  persistState()
  return {
    ok: true,
    engine: 'v2',
    runId: engine.getManifest().runId,
    artifacts: composeState.artifacts,
    tasks: composeState.tasks,
    taskCount: planOut.tasks.length
  }
}

/** 供外部取脚本指纹（与 builtin 源一致时用于 manifest） */
export function brFullDevV2ScriptSha(source: string): string {
  return scriptSha(source)
}
