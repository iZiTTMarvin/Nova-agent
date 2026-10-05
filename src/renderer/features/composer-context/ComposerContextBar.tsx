/**
 * ComposerContextBar — 垫在输入卡片正下方、与卡片等宽连体的延伸条，承载工作区与 Git 分支 chip。
 * 只做排版组装；各 chip 拥有自己的数据与交互。
 */
import React from 'react'
import { WorkspaceChip } from './WorkspaceChip'
import { GitBranchSwitcher } from './GitBranchSwitcher'
import './composerContext.css'

export const ComposerContextBar: React.FC = () => {
  return (
    <div className="composer-context-bar" data-testid="composer-context-bar">
      <WorkspaceChip />
      <GitBranchSwitcher />
    </div>
  )
}
