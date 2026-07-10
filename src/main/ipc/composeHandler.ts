/**
 * 编排模式 IPC：run / cancel / status / resume
 * 主要入口仍是 slash `/br-full-dev`（经 AgentLoop workflowRunner）；
 * 本 handler 供 UI 进度面板与显式 resume/cancel。
 *
 * 依赖装配与 agentHandler 的 workflowRunner 同构，避免 COMPOSE_RUN 路径
 * 缺少 checkpoint / permissionBridge / contextWindow 等能力。
 */
import { BrowserWindow, app } from 'electron'
import { handle } from './secureIpc'
import {
  COMPOSE_RUN,
  COMPOSE_CANCEL,
  COMPOSE_STATUS,
  COMPOSE_RESUME,
  COMPOSE_RESPOND_ASK_USER,
  COMPOSE_GET_STATE,
  COMPOSE_INSPECT_RESUME,
  COMPOSE_ROLLBACK,
  COMPOSE_NEW_ANALYSIS,
  COMPOSE_PHASE_CHANGE,
  COMPOSE_LOG,
  COMPOSE_ASK_USER,
  COMPOSE_TASK_UPDATE,
  COMPOSE_STATE
} from '../../shared/ipc/channels'
import {
  runWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  resolveWorkflowAskUser,
  readComposeState,
  inspectComposeResume,
  getComposeV2Manifest
} from '../../runtime/workflow'
import type { WorkflowRuntimeDeps } from '../../runtime/workflow'
import { EventBus } from '../../runtime/agent/EventBus'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow, resolveSupportsVision } from '../../shared/config/types'
import { ToolRegistry } from '../../runtime/tools/ToolRegistry'
import { lsTool } from '../../runtime/tools/lsTool'
import { readTool } from '../../runtime/tools/readTool'
import { editTool } from '../../runtime/tools/editTool'
import { writeTool } from '../../runtime/tools/writeTool'
import { bashTool } from '../../runtime/tools/bashTool'
import { createGrepTool } from '../../runtime/tools/grepTool'
import { findTool } from '../../runtime/tools/findTool'
import { defaultSubAgentPermissionBridge } from '../../runtime/tools/subAgentBridge'
import { CheckpointManager } from '../../runtime/checkpoints/CheckpointManager'
import { getSessionActiveMessages } from '../../runtime/sessions/tree'
import { getSkillService } from '../services/SkillServiceHost'
import { getSessionStore } from './sessionHandler'
import { getRunCoordinator, getRunExecutionRegistry, setActiveRunId } from '../services/RunCoordinatorHost'
import { runComposeWithLifecycle } from './composeRunLifecycle'

function buildComposeDeps(
  workspaceRoot: string,
  eventBus: EventBus,
  sessionId?: string
): WorkflowRuntimeDeps {
  const persisted = loadModelConfig(app.getPath('userData'))
  const modelClient = new OpenAICompatibleModelClient({
    baseUrl: persisted?.baseUrl ?? '',
    apiKey: persisted?.apiKey ?? '',
    modelId: persisted?.modelId ?? ''
  })
  const contextWindow = persisted?.contextWindow ?? inferContextWindow(persisted?.modelId ?? '')
  const supportsVision = resolveSupportsVision(persisted?.modelId ?? '', persisted?.supportsVision)

  const toolRegistry = new ToolRegistry()
  toolRegistry.register(lsTool)
  toolRegistry.register(readTool)
  toolRegistry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
  toolRegistry.register(findTool)
  toolRegistry.register(editTool)
  toolRegistry.register(writeTool)
  toolRegistry.register(bashTool)

  const skillService = getSkillService()
  if (skillService.getWorkspaceRoot() !== workspaceRoot) {
    skillService.load(workspaceRoot)
  }
  const skillRegistry = skillService.getRegistry()

  // 有 sessionId 时挂 checkpoint，与 agentHandler workflowRunner 对齐
  let checkpointManager: CheckpointManager | undefined
  if (sessionId) {
    try {
      const sessionStore = getSessionStore()
      checkpointManager = new CheckpointManager({
        checkpointDir: sessionStore.getSessionsDir(),
        sessionId,
        workspaceRoot,
        getActivePathMessageIds: () => {
          const s = sessionStore.load(sessionId)
          if (!s) return undefined
          return new Set(getSessionActiveMessages(s).map((m) => m.id))
        }
      })
    } catch {
      // SessionStore 未初始化时降级为无 checkpoint（单测 / 异常启动路径）
      checkpointManager = undefined
    }
  }

  return {
    modelClient,
    parentEventBus: eventBus,
    resolveTool: (name: string) => toolRegistry.getTool(name),
    resolveSkill: (name: string) => skillRegistry.get(name),
    workspaceRoot,
    permissionBridge: defaultSubAgentPermissionBridge,
    checkpointManager,
    contextWindow,
    supportsVision,
    mode: 'compose',
    sessionId
  }
}

function wireComposeEvents(
  eventBus: EventBus,
  getMainWindow: () => BrowserWindow | null
): () => void {
  return eventBus.on((event) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (wc.isDestroyed()) return
    if (event.type === 'workflow_phase') {
      wc.send(COMPOSE_PHASE_CHANGE, { runId: event.runId, sessionId: event.sessionId, phase: event.phase })
    }
    if (event.type === 'workflow_log') {
      wc.send(COMPOSE_LOG, { runId: event.runId, sessionId: event.sessionId, message: event.message })
    }
    if (event.type === 'workflow_ask_user') {
      // 统一纳入 InteractionInbox，重启后可从 snapshot 恢复挂起交互
      try {
        const coord = getRunCoordinator()
        if (event.sessionId) {
          coord.inbox.enqueue({
            runId: event.runId,
            sessionId: event.sessionId,
            messageId: event.requestId,
            type: 'composeAskUser',
            interactionId: event.requestId,
            payload: {
              requestId: event.requestId,
              question: event.question,
              options: event.options
            }
          })
        }
      } catch {
        // RunCoordinator 未初始化时仍转发 IPC（测试 / 早期启动）
      }
      wc.send(COMPOSE_ASK_USER, {
        runId: event.runId,
        sessionId: event.sessionId,
        requestId: event.requestId,
        question: event.question,
        options: event.options
      })
    }
    if (event.type === 'workflow_task_update') {
      wc.send(COMPOSE_TASK_UPDATE, { runId: event.runId, sessionId: event.sessionId, tasks: event.tasks })
    }
    if (event.type === 'workflow_state') {
      wc.send(COMPOSE_STATE, { runId: event.runId, sessionId: event.sessionId, state: event.state })
    }
  })
}

export function registerComposeHandler(getMainWindow: () => BrowserWindow | null): void {
  handle(COMPOSE_RUN, async (_e, params: {
    scriptName: string
    args?: string
    workspaceRoot: string
    sessionId?: string
  }) => {
    const eventBus = new EventBus()
    const unsub = wireComposeEvents(eventBus, getMainWindow)
    const coord = getRunCoordinator()
    const registry = getRunExecutionRegistry()
    let capturedRunId = ''
    try {
      const result = await runComposeWithLifecycle(
        {
          coord,
          registry,
          runWorkflow,
          cancelWorkflow
        },
        {
          workspaceRoot: params.workspaceRoot,
          sessionId: params.sessionId,
          onRunStarted: (runId) => {
            capturedRunId = runId
            setActiveRunId(runId)
          },
          workflowOpts: {
            script: params.scriptName,
            args: { requirement: params.args ?? '', task: params.args ?? '' },
            deps: buildComposeDeps(params.workspaceRoot, eventBus, params.sessionId)
          }
        }
      )
      return { runId: result.runId, status: result.status }
    } finally {
      if (capturedRunId) setActiveRunId(null)
      unsub()
    }
  })

  handle(COMPOSE_CANCEL, async (_e, params: { runId: string }) => {
    const coord = getRunCoordinator()
    const registry = getRunExecutionRegistry()
    coord.beginCancel(params.runId)
    coord.inbox.cancelAllForRun(params.runId)
    // 先经 registry.abort（触发 cancelWorkflow），再兜底 cancelWorkflow
    await registry.abort(params.runId, 'compose_cancel')
    const cancelled = cancelWorkflow(params.runId)
    return { cancelled: cancelled || true }
  })

  handle(COMPOSE_STATUS, async (_e, params: { runId: string }) => {
    // 优先 RunCoordinator 权威快照；无则回落 workflow 进程内状态
    try {
      const snap = getRunCoordinator().getSnapshot(params.runId)
      if (snap) {
        return {
          runId: snap.runId,
          status: snap.status,
          phase: typeof snap.progress?.extras?.phase === 'string'
            ? snap.progress.extras.phase
            : snap.progress?.label
        }
      }
    } catch {
      /* coordinator 未初始化 */
    }
    const s = getWorkflowStatus(params.runId)
    if (!s) return null
    return { runId: s.runId, status: s.status, phase: s.phase }
  })

  handle(COMPOSE_RESUME, async (_e, params: {
    runId: string
    scriptName: string
    args?: string
    workspaceRoot: string
    sessionId?: string
    rerunFromStepId?: string
    scriptShaMismatch?: 'reject' | 'migrate'
  }) => {
    const eventBus = new EventBus()
    const unsub = wireComposeEvents(eventBus, getMainWindow)
    try {
      const result = await runComposeWithLifecycle(
        {
          coord: getRunCoordinator(),
          registry: getRunExecutionRegistry(),
          runWorkflow,
          cancelWorkflow
        },
        {
          workspaceRoot: params.workspaceRoot,
          sessionId: params.sessionId,
          runId: params.runId,
          resume: true,
          workflowOpts: {
            script: params.scriptName,
            args: { requirement: params.args ?? '', task: params.args ?? '' },
            deps: buildComposeDeps(params.workspaceRoot, eventBus, params.sessionId),
            rerunFromStepId: params.rerunFromStepId,
            scriptShaMismatch: params.scriptShaMismatch
          }
        }
      )
      return { runId: result.runId, status: result.status }
    } finally {
      unsub()
    }
  })

  // 阶段 E 弹窗会调此接口；应答经 InteractionInbox 幂等后再解除脚本阻塞
  handle(COMPOSE_RESPOND_ASK_USER, async (_e, params: {
    runId: string
    requestId: string
    answer: string
    commandId?: string
  }) => {
    const coord = getRunCoordinator()
    const inter = coord.inbox.find(params.requestId)
    if (!inter) {
      // 无持久化 interaction：不得绕过 inbox 直接 resolve
      return {
        ok: false,
        code: 'not_found',
        message: `compose askUser ${params.requestId} 不在 run snapshot 中`
      }
    }
    const result = coord.inbox.answer({
      interactionId: params.requestId,
      commandId: params.commandId ?? `compose-ask-${params.requestId}`,
      expectedVersion: inter.version,
      outcome: 'answered',
      payload: { answer: params.answer }
    })
    // 失败或重复：返回 ACK，不得再 resolve 脚本
    if (!result.ok || !result.firstApplied) {
      return result
    }
    const resolved = resolveWorkflowAskUser(params.runId, params.requestId, params.answer)
    return {
      ok: resolved,
      firstApplied: true,
      interaction: result.interaction,
      snapshot: result.snapshot
    }
  })

  handle(COMPOSE_GET_STATE, async (_e, params: { workspaceRoot: string; runId?: string }) => {
    const state = readComposeState(params.workspaceRoot, params.runId)
    if (!state) return null
    try {
      return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
    } catch {
      return null
    }
  })

  handle(COMPOSE_INSPECT_RESUME, async (_e, params: {
    workspaceRoot: string
    runId: string
    rerunFromStepId?: string
  }) => {
    const manifest = getComposeV2Manifest(params.workspaceRoot, params.runId)
    if (!manifest) {
      // v1：无 step graph，告知 UI 只能「重新执行并复用结果」
      return {
        engine: 'v1' as const,
        skip: [] as Array<{ stepId: string; kind: string; status: string }>,
        run: [] as Array<{ stepId: string; kind: string; status: string }>,
        blocked: [] as Array<{ stepId: string; kind: string; error?: string }>
      }
    }
    const plan = inspectComposeResume(
      params.workspaceRoot,
      params.runId,
      params.rerunFromStepId
    )
    if (!plan) return null
    return {
      engine: 'v2' as const,
      skip: plan.skip,
      run: plan.run,
      blocked: plan.blocked
    }
  })

  handle(COMPOSE_ROLLBACK, async (_e, params: {
    workspaceRoot: string
    runId: string
    sessionId?: string
  }) => {
    // 禁止 git reset --hard / git clean；仅按 FileEffectReceipt 逆序安全回滚。
    void params.sessionId
    const { listFileEffects, previewRollback, confirmRollback } = await import(
      '../../runtime/workflow/v2/EffectReceipt'
    )
    const effects = listFileEffects(params.workspaceRoot, params.runId)
    if (effects.length === 0) {
      return {
        ok: false,
        error:
          '无可回滚的文件副作用凭证。请使用会话消息回退 / 逐文件 checkpoint；未执行任何文件回滚。'
      }
    }
    const preview = previewRollback(params.workspaceRoot, params.runId)
    const result = confirmRollback(params.workspaceRoot, params.runId)
    return {
      ok: result.ok,
      restored: result.results.filter((r) => r.status === 'restored' || r.status === 'deleted').length,
      error: result.ok
        ? undefined
        : `回滚未完全成功：冲突 ${preview.conflicts.length}，缺备份 ${preview.missingBackup.length}`,
      preview,
      results: result.results
    }
  })

  handle(COMPOSE_NEW_ANALYSIS, async (_e, params: {
    scriptName: string
    args?: string
    workspaceRoot: string
    sessionId?: string
  }) => {
    // 保留工作区，开新 runId（不 resume）
    const eventBus = new EventBus()
    const unsub = wireComposeEvents(eventBus, getMainWindow)
    try {
      const result = await runComposeWithLifecycle(
        {
          coord: getRunCoordinator(),
          registry: getRunExecutionRegistry(),
          runWorkflow,
          cancelWorkflow
        },
        {
          workspaceRoot: params.workspaceRoot,
          sessionId: params.sessionId,
          workflowOpts: {
            script: params.scriptName,
            args: { requirement: params.args ?? '', task: params.args ?? '' },
            deps: buildComposeDeps(params.workspaceRoot, eventBus, params.sessionId)
          }
        }
      )
      return { runId: result.runId, status: result.status }
    } finally {
      unsub()
    }
  })
}
