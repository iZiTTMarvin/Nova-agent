/**
 * Composer 工作区 chip 的纯展示逻辑：项目列表派生、默认工作区排除与搜索过滤。
 */
import { describe, expect, it } from 'vitest'
import {
  filterWorkspaceProjects,
  listWorkspaceProjects,
  workspaceLabel
} from '../../../../src/renderer/features/composer-context/workspaceDisplay'
import type { Session } from '../../../../src/shared/session/types'

function sessionOf(id: string, workspaceRoot: string, updatedAt: number): Session {
  return {
    id,
    workspaceRoot,
    mode: 'default',
    permissionMode: 'auto',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    kind: 'primary'
  }
}

describe('workspaceLabel', () => {
  it('默认工作区显示固定名；普通路径取末段；Windows 反斜杠同样处理', () => {
    expect(workspaceLabel('/home/me/projects/app', '')).toBe('app')
    expect(workspaceLabel('D:\\work\\nova', '')).toBe('nova')
    expect(workspaceLabel('/home/me/.nova/workspace', '/home/me/.nova/workspace')).toBe('Nova 工作区')
  })
})

describe('listWorkspaceProjects', () => {
  it('按 workspaceRoot 去重、取最近使用时间、排除默认工作区', () => {
    const sessions = [
      sessionOf('s1', '/ws/a', 100),
      sessionOf('s2', '/ws/a', 300),
      sessionOf('s3', '/ws/b', 200),
      sessionOf('s4', '/ws/default', 999)
    ]
    expect(listWorkspaceProjects(sessions, '/ws/default')).toEqual([
      { path: '/ws/a', updatedAt: 300 },
      { path: '/ws/b', updatedAt: 200 }
    ])
    expect(listWorkspaceProjects(sessions, '').map(entry => entry.path)).toContain('/ws/default')
  })
})

describe('filterWorkspaceProjects', () => {
  const projects = [
    { path: '/ws/nova-agent', updatedAt: 2 },
    { path: '/ws/zcode-learning', updatedAt: 1 }
  ]

  it('匹配完整路径或末段；空查询全量', () => {
    expect(filterWorkspaceProjects(projects, 'zcode').map(entry => entry.path)).toEqual([
      '/ws/zcode-learning'
    ])
    expect(filterWorkspaceProjects(projects, 'ws/nova').map(entry => entry.path)).toEqual([
      '/ws/nova-agent'
    ])
    expect(filterWorkspaceProjects(projects, '  ')).toHaveLength(2)
    expect(filterWorkspaceProjects(projects, 'missing')).toEqual([])
  })
})
