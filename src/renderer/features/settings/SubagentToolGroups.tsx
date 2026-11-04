/**
 * SubagentToolGroups — 子代理工具白名单：按“能做的最重的事”分组，风险一眼可见。
 * 可编辑时每个工具是一枚可开关的胶囊；只读时只列出已选工具。
 */
import React from 'react'
import type { SubagentToolOption } from '../../../shared/settings/types'
import { CheckIcon } from '../../components/Icons'
import './SubagentToolGroups.css'

const EFFECT_LABELS: Record<string, string> = {
  'filesystem.read': '读取文件',
  'filesystem.write': '修改文件',
  'shell.execute': '执行命令',
  'process.control': '控制进程',
  'network.read': '访问网络',
  'network.write': '写入网络',
  'session.write': '修改会话',
  orchestration: '派遣代理',
  'mode.transition': '切换模式'
}

const TOOL_GROUPS = [
  { id: 'read', title: '只读', caution: false },
  { id: 'write', title: '修改文件', caution: true },
  { id: 'shell', title: '命令与进程', caution: true },
  { id: 'network', title: '写入网络', caution: true },
  { id: 'coordinate', title: '协作与会话', caution: false }
] as const

type ToolGroupId = typeof TOOL_GROUPS[number]['id']

function toolGroup(tool: SubagentToolOption): ToolGroupId {
  const has = (effect: string) => (tool.effects as readonly string[]).includes(effect)
  if (has('shell.execute') || has('process.control')) return 'shell'
  if (has('filesystem.write')) return 'write'
  if (has('network.write')) return 'network'
  if (has('orchestration') || has('mode.transition') || has('session.write')) return 'coordinate'
  return 'read'
}

function toolHint(tool: SubagentToolOption): string {
  return tool.effects.map(effect => EFFECT_LABELS[effect] ?? effect).join('、') || '无外部副作用'
}

/** 已选工具里是否含有会修改工作区的能力（修改文件 / 命令 / 网络写入） */
export function summarizeToolPermission(
  tools: readonly SubagentToolOption[],
  selected: readonly string[]
): { selectedCount: number; total: number; canWrite: boolean } {
  const selectable = tools.filter(tool => tool.selectable)
  const chosen = selectable.filter(tool => selected.includes(tool.name))
  return {
    selectedCount: chosen.length,
    total: selectable.length,
    canWrite: chosen.some(tool => ['write', 'shell', 'network'].includes(toolGroup(tool)))
  }
}

interface SubagentToolGroupsProps {
  tools: readonly SubagentToolOption[]
  selected: readonly string[]
  /** 缺省为只读展示 */
  onToggle?: (name: string, checked: boolean) => void
  disabled?: boolean
}

export const SubagentToolGroups: React.FC<SubagentToolGroupsProps> = ({ tools, selected, onToggle, disabled }) => {
  const selectable = tools.filter(tool => tool.selectable && (onToggle || selected.includes(tool.name)))
  return (
    <fieldset className="subagent-tools" disabled={disabled}>
      <legend className="subagent-tools__legend">工具白名单</legend>
      {TOOL_GROUPS.map(group => {
        const groupTools = selectable.filter(tool => toolGroup(tool) === group.id)
        if (groupTools.length === 0) return null
        return (
          <div key={group.id} className="subagent-tools__group">
            <div className={`subagent-tools__title${group.caution ? ' subagent-tools__title--caution' : ''}`}>
              {group.title}
            </div>
            <div className="subagent-tools__list">
              {groupTools.map(tool => {
                const isSelected = selected.includes(tool.name)
                if (!onToggle) {
                  return (
                    <span key={tool.name} className="subagent-tool glass-chip glass-chip--accent" title={toolHint(tool)}>
                      <code>{tool.name}</code>
                    </span>
                  )
                }
                return (
                  <button
                    key={tool.name}
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    title={toolHint(tool)}
                    className={`subagent-tool subagent-tool--toggle glass-chip${isSelected ? ' glass-chip--accent' : ''}`}
                    onClick={() => onToggle(tool.name, !isSelected)}
                  >
                    <span className="subagent-tool__mark" aria-hidden="true">{isSelected && <CheckIcon size={10} />}</span>
                    <code>{tool.name}</code>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </fieldset>
  )
}
