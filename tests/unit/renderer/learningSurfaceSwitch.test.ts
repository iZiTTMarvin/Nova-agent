// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../src/shared/session/types'
import {
  findDevSessionForProject,
  findLearnSessionForProject,
  isLearnSession,
  readLastDevSession,
  rememberLastDevSession
} from '../../../src/renderer/features/learning/learningSurfaceSwitch'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'

function session(id: string, mode: Session['mode'], updatedAt: number): Session {
  return {
    id,
    kind: 'primary',
    workspaceRoot: 'D:/workspace',
    mode,
    createdAt: 1,
    updatedAt,
    messageCount: 0,
    title: id
  }
}

describe('学习表面切换', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('按表面挑会话：学习面只认 learn，开发面只认开发模式', () => {
    const sessions = [
      session('dev-old', 'default', 1),
      session('dev-new', 'plan', 5),
      session('learn', 'learn', 3)
    ]
    expect(findLearnSessionForProject(sessions, 'D:/workspace')?.id).toBe('learn')
    expect(findDevSessionForProject(sessions, 'D:/workspace')?.id).toBe('dev-new')
    expect(findDevSessionForProject(sessions, 'D:/other')).toBeNull()
    expect(isLearnSession(session('l', 'learn', 1))).toBe(true)
    expect(isLearnSession(session('d', 'default', 1))).toBe(false)
  })

  it('返回开发优先恢复记录的原开发会话', () => {
    const sessions = [
      session('dev-old', 'default', 1),
      session('dev-new', 'compose', 5)
    ]
    rememberLastDevSession('D:/workspace', 'dev-old')
    expect(readLastDevSession('D:/workspace')).toBe('dev-old')
    expect(findDevSessionForProject(sessions, 'D:/workspace', readLastDevSession('D:/workspace'))?.id).toBe(
      'dev-old'
    )
    // 记录的会话已不存在时回落到最近开发会话，不落到学习会话
    expect(findDevSessionForProject(sessions, 'D:/workspace', 'missing')?.id).toBe('dev-new')
  })

  it('切到学习会记住原开发会话并选择本项目 learn 会话', async () => {
    const selectSession = vi.fn(async () => undefined)
    const createSession = vi.fn(async () => undefined)
    useWorkspaceStore.setState({
      currentProjectPath: 'D:/workspace',
      currentMode: 'default',
      currentSessionId: 'dev-1',
      availableSessions: [session('dev-1', 'default', 1), session('learn-1', 'learn', 2)],
      selectSession,
      createSession
    } as never)

    const { switchToLearningSurface } = await import(
      '../../../src/renderer/features/learning/learningSurfaceSwitch'
    )
    await switchToLearningSurface()

    expect(readLastDevSession('D:/workspace')).toBe('dev-1')
    expect(createSession).not.toHaveBeenCalled()
    expect(selectSession).toHaveBeenCalledWith('learn-1')
  })

  it('没有 learn 会话时新建学习会话，不原地改开发会话模式', async () => {
    const selectSession = vi.fn(async () => undefined)
    const createSession = vi.fn(async () => undefined)
    useWorkspaceStore.setState({
      currentProjectPath: 'D:/workspace',
      currentMode: 'default',
      currentSessionId: 'dev-1',
      availableSessions: [session('dev-1', 'default', 1)],
      selectSession,
      createSession
    } as never)

    const { switchToLearningSurface } = await import(
      '../../../src/renderer/features/learning/learningSurfaceSwitch'
    )
    await switchToLearningSurface()

    expect(selectSession).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledWith('D:/workspace', 'learn')
  })

  it('返回开发选择记录的开发会话', async () => {
    const selectSession = vi.fn(async () => undefined)
    const createSession = vi.fn(async () => undefined)
    rememberLastDevSession('D:/workspace', 'dev-9')
    useWorkspaceStore.setState({
      currentProjectPath: 'D:/workspace',
      currentMode: 'learn',
      currentSessionId: 'learn-1',
      availableSessions: [session('dev-9', 'default', 1), session('learn-1', 'learn', 2)],
      selectSession,
      createSession
    } as never)

    const { switchToDevSurface } = await import(
      '../../../src/renderer/features/learning/learningSurfaceSwitch'
    )
    await switchToDevSurface()

    expect(selectSession).toHaveBeenCalledWith('dev-9')
    expect(createSession).not.toHaveBeenCalled()
  })
})
