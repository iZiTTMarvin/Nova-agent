import type { HostFns, IntegrateResult, WorktreeHandle } from '../../host'
import { topoSort } from '../../scheduling/topo'
import type { PlanTask, WorkflowPlan } from '../../types'
import type {
  BrainstormResult,
  ImplementResult,
  ImplementTaskResult
} from './types'

interface TaskExecution {
  task: PlanTask
  result: ImplementTaskResult
  worktree?: WorktreeHandle
}

function taskPrompt(task: PlanTask, plan: WorkflowPlan, brainstorm: BrainstormResult | null): string {
  const context = brainstorm
    ? `\n已确认的方案方向：${brainstorm.recommendation}\n方案摘要：${brainstorm.summary}`
    : ''
  return [
    '你负责 compose workflow 的 implement 阶段。',
    '只实现当前任务，不向用户提问，不扩大范围，不修改与任务无关的文件。',
    '先阅读真实代码、测试和规则；按验收标准工作，并在结束时简洁说明改动和验证证据。',
    `任务 ${task.id}：${task.title}`,
    `依赖：${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '无'}`,
    `验收标准：${task.acceptance.length > 0 ? task.acceptance.join('；') : '由任务标题和计划目标确定'}`,
    `整体目标：${plan.goal}`,
    context
  ].join('\n')
}

function batchHasCycle(batch: PlanTask[]): boolean {
  const ids = new Set(batch.map((task) => task.id))
  return batch.some((task) => task.dependsOn.some((dependency) => ids.has(dependency)))
}

function textSummary(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function failureResult(task: PlanTask, failure: string, worktree?: WorktreeHandle): TaskExecution {
  return {
    task,
    ...(worktree ? { worktree } : {}),
    result: {
      taskId: task.id,
      title: task.title,
      status: 'failed',
      failure,
      ...(worktree ? { worktree } : {})
    }
  }
}

function successResult(task: PlanTask, output: unknown, worktree?: WorktreeHandle): TaskExecution {
  const summary = textSummary(output)
  return {
    task,
    ...(worktree ? { worktree } : {}),
    result: {
      taskId: task.id,
      title: task.title,
      status: 'succeeded',
      ...(summary ? { summary } : {}),
      ...(worktree ? { worktree } : {})
    }
  }
}

async function runSharedTask(
  host: HostFns,
  task: PlanTask,
  plan: WorkflowPlan,
  brainstorm: BrainstormResult | null
): Promise<TaskExecution> {
  try {
    const output = await host.agent(taskPrompt(task, plan, brainstorm), {
      phase: 'implement',
      isolation: 'shared',
      interactive: false,
      label: `compose-implement-${task.id}`
    })
    return output === null
      ? failureResult(task, '实现 agent 未产出结果')
      : successResult(task, output)
  } catch (error) {
    return failureResult(task, error instanceof Error ? error.message : String(error))
  }
}

async function prepareWorktreeTask(
  host: HostFns,
  task: PlanTask,
  plan: WorkflowPlan,
  brainstorm: BrainstormResult | null
): Promise<TaskExecution> {
  let worktree: WorktreeHandle
  try {
    worktree = await host.worktree(`compose-implement-${task.id}`)
  } catch (error) {
    return failureResult(task, `worktree 创建失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const output = await host.agent(taskPrompt(task, plan, brainstorm), {
      phase: 'implement',
      isolation: 'worktree',
      directory: worktree.directory,
      worktreeKey: worktree.key,
      interactive: false,
      label: `compose-implement-${task.id}`
    })
    if (output === null) {
      await host.cleanupWorktree(worktree.directory).catch(() => false)
      return failureResult(task, '隔离实现 agent 未产出结果', worktree)
    }
    return successResult(task, output, worktree)
  } catch (error) {
    await host.cleanupWorktree(worktree.directory).catch(() => false)
    return failureResult(task, error instanceof Error ? error.message : String(error), worktree)
  }
}

async function integrateTask(
  host: HostFns,
  execution: TaskExecution
): Promise<ImplementTaskResult> {
  if (!execution.worktree || execution.result.status === 'failed') return execution.result

  let integration: IntegrateResult
  try {
    integration = await host.integrate(execution.worktree.directory, {
      message: `workflow: implement ${execution.task.id}`,
      context: `任务：${execution.task.title}`
    })
  } catch (error) {
    return {
      ...execution.result,
      status: 'failed',
      failure: `integrate 异常：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (integration.status === 'merged' || integration.status === 'pristine') {
    return { ...execution.result, integration }
  }
  return {
    ...execution.result,
    status: 'failed',
    failure:
      integration.status === 'conflict'
        ? `integrate 冲突：${integration.files.join(', ') || '未知文件'}`
        : `integrate 失败：${integration.reason}`,
    integration
  }
}

function dependencyFailure(task: PlanTask, succeeded: Set<string>): string | null {
  const missing = task.dependsOn.find((dependency) => !succeeded.has(dependency))
  return missing ? `依赖任务 ${missing} 未成功完成` : null
}

/** 按依赖批次执行实现任务；失败任务只影响自己的后继，不取消同批独立任务。 */
export async function runImplement(
  host: HostFns,
  plan: WorkflowPlan,
  brainstorm: BrainstormResult | null
): Promise<ImplementResult> {
  host.progress('implement', 'started')
  const batches = topoSort(plan.tasks.map((task) => ({ ...task, deps: task.dependsOn })))
  const tasks: ImplementTaskResult[] = []
  const succeeded = new Set<string>()
  const failed = new Set<string>()
  let fatalReason: string | undefined

  if (batches.some((batch) => batchHasCycle(batch))) {
    fatalReason = 'WorkflowPlan 存在循环依赖，无法形成可执行批次'
  }

  for (let batchIndex = 0; batchIndex < batches.length && !fatalReason; batchIndex += 1) {
    if (batchHasCycle(batches[batchIndex]!)) {
      fatalReason = '拓扑排序返回了包含内部依赖的批次'
      break
    }
    host.progress('implement', 'batch_started', {
      batchIndex,
      batchSize: batches[batchIndex]!.length
    })

    const eligible: PlanTask[] = []
    for (const task of batches[batchIndex]!) {
      const dependencyError = dependencyFailure(task, succeeded)
      if (dependencyError) {
        failed.add(task.id)
        const result = failureResult(task, dependencyError).result
        tasks.push(result)
        host.progress('implement', 'task_failed', {
          taskId: task.id,
          taskName: task.title,
          batchIndex,
          batchSize: batches[batchIndex]!.length,
          message: dependencyError
        })
      } else {
        eligible.push(task)
        host.progress('implement', 'task_started', {
          taskId: task.id,
          taskName: task.title,
          batchIndex,
          batchSize: batches[batchIndex]!.length
        })
      }
    }

    const isolated = eligible.length > 1
    const executions = await Promise.all(
      eligible.map((task) =>
        isolated
          ? prepareWorktreeTask(host, task, plan, brainstorm)
          : runSharedTask(host, task, plan, brainstorm)
      )
    )

    const integrated = isolated
      ? await integrateBatch(host, executions)
      : executions.map((execution) => execution.result)

    for (const result of integrated) {
      tasks.push(result)
      if (result.status === 'succeeded') {
        succeeded.add(result.taskId)
        host.progress('implement', 'task_complete', {
          taskId: result.taskId,
          taskName: result.title,
          batchIndex,
          batchSize: batches[batchIndex]!.length,
          message: result.integration?.status ?? result.summary
        })
      } else {
        failed.add(result.taskId)
        host.progress('implement', 'task_failed', {
          taskId: result.taskId,
          taskName: result.title,
          batchIndex,
          batchSize: batches[batchIndex]!.length,
          message: result.failure ?? '实现任务失败'
        })
        if (result.integration?.status === 'conflict' || result.integration?.status === 'failed') {
          fatalReason = result.failure ?? 'integrate 失败'
        }
      }
    }
    host.progress('implement', 'batch_merge', {
      batchIndex,
      batchSize: batches[batchIndex]!.length,
      message: isolated ? '批次 worktree 已完成合并处理' : '单任务批已在主工作区完成'
    })
  }

  if (!fatalReason && succeeded.size === 0) fatalReason = '所有实现任务均失败或因依赖失败而无法执行'
  const status = fatalReason ? 'failed' : failed.size > 0 ? 'partial' : 'completed'
  const result: ImplementResult = {
    status,
    batches: batches.length,
    tasks,
    succeededTaskIds: [...succeeded],
    failedTaskIds: [...failed],
    ...(fatalReason ? { fatalReason } : {})
  }
  host.progress('implement', fatalReason ? 'failed' : 'completed', {
    message: fatalReason ?? (failed.size > 0 ? `有 ${failed.size} 个任务失败` : '所有实现任务完成')
  })
  return result
}

async function integrateBatch(
  host: HostFns,
  executions: TaskExecution[]
): Promise<ImplementTaskResult[]> {
  const results: ImplementTaskResult[] = []
  for (const execution of executions) {
    if (execution.result.status === 'failed') {
      results.push(execution.result)
      continue
    }
    results.push(await integrateTask(host, execution))
    const last = results[results.length - 1]!
    if (last.integration?.status === 'conflict' || last.integration?.status === 'failed') {
      for (const remaining of executions.slice(results.length)) {
        if (remaining.result.status === 'succeeded') {
          results.push({
            ...remaining.result,
            status: 'failed',
            failure: '前一个 worktree integrate 失败，保留现场等待处理'
          })
        } else {
          results.push(remaining.result)
        }
      }
      break
    }
  }
  return results
}
