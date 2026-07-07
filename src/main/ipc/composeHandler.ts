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
  readComposeState
} from '../../runtime/workflow'
import type { WorkflowRuntimeDeps } from '../../runtime/workflow'
import { EventBus } from '../../runtime/agent/EventBus'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig } from '../../runtime/model/config'
import { inferContextWindow, inferVisionSupport } from '../../shared/config/types'
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
  const supportsVision = persisted?.supportsVision ?? inferVisionSupport(persisted?.modelId ?? '')

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
      wc.send(COMPOSE_PHASE_CHANGE, { runId: event.runId, phase: event.phase })
    }
    if (event.type === 'workflow_log') {
      wc.send(COMPOSE_LOG, { runId: event.runId, message: event.message })
    }
    if (event.type === 'workflow_ask_user') {
      wc.send(COMPOSE_ASK_USER, {
        runId: event.runId,
        requestId: event.requestId,
        question: event.question,
        options: event.options
      })
    }
    if (event.type === 'workflow_task_update') {
      wc.send(COMPOSE_TASK_UPDATE, { runId: event.runId, tasks: event.tasks })
    }
    if (event.type === 'workflow_state') {
      wc.send(COMPOSE_STATE, { runId: event.runId, state: event.state })
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
    try {
      const outcome = await runWorkflow({
        script: params.scriptName,
        args: { requirement: params.args ?? '', task: params.args ?? '' },
        deps: buildComposeDeps(params.workspaceRoot, eventBus, params.sessionId)
      })
      return { runId: outcome.runId, status: outcome.status }
    } finally {
      unsub()
    }
  })

  handle(COMPOSE_CANCEL, async (_e, params: { runId: string }) => {
    return { cancelled: cancelWorkflow(params.runId) }
  })

  handle(COMPOSE_STATUS, async (_e, params: { runId: string }) => {
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
  }) => {
    const eventBus = new EventBus()
    const unsub = wireComposeEvents(eventBus, getMainWindow)
    try {
      const outcome = await runWorkflow({
        script: params.scriptName,
        args: { requirement: params.args ?? '', task: params.args ?? '' },
        deps: buildComposeDeps(params.workspaceRoot, eventBus, params.sessionId),
        runId: params.runId,
        resume: true
      })
      return { runId: outcome.runId, status: outcome.status }
    } finally {
      unsub()
    }
  })

  // 阶段 E 弹窗会调此接口；阶段 D 提供最小后端，测试也可直接调 resolveWorkflowAskUser
  handle(COMPOSE_RESPOND_ASK_USER, async (_e, params: {
    runId: string
    requestId: string
    answer: string
  }) => {
    return { ok: resolveWorkflowAskUser(params.runId, params.requestId, params.answer) }
  })

  handle(COMPOSE_GET_STATE, async (_e, params: { workspaceRoot: string }) => {
    const state = readComposeState(params.workspaceRoot)
    if (!state) return null
    try {
      return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
    } catch {
      return null
    }
  })
}
