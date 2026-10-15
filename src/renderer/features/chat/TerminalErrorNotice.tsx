/**
 * TerminalErrorNotice — 轮次终态错误提示卡
 *
 * 落在消息正文末尾：正文保持正常配色，只有提示卡带语义色，动作按钮与文案同处一卡。
 * 历史会话重载后没有运行期动作，只剩文案，位置与观感保持一致。
 */
import React from 'react'
import { Button } from '@astryxdesign/core/Button'
import { AlertIcon } from '../../components/Icons'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { TerminalErrorAction } from '../../../shared/session/terminalErrorBlocks'
import './TerminalErrorNotice.css'

const ACTION_LABELS: Record<TerminalErrorAction, string> = {
  'open-settings': '去设置检查',
  'switch-model': '换模型',
  retry: '重试',
  'new-session': '开新会话',
  'export-diagnostics': '导出诊断包'
}

export interface TerminalErrorNoticeProps {
  /** 已翻译成人话的提示文案，不含 ⚠️ 前缀 */
  notice: string
  actions?: TerminalErrorAction[]
  messageId: string
  onRegenerate: (messageId: string) => void
}

export const TerminalErrorNotice: React.FC<TerminalErrorNoticeProps> = React.memo(
  function TerminalErrorNotice({ notice, actions, messageId, onRegenerate }) {
    const handleAction = (action: TerminalErrorAction) => {
      switch (action) {
        case 'retry':
          onRegenerate(messageId)
          break
        case 'open-settings':
        case 'switch-model':
          useSettingsStore.getState().setConfigModalOpen(true)
          break
        case 'new-session':
          void useChatStore.getState().createNewSession(useSettingsStore.getState().currentProject ?? undefined)
          break
        case 'export-diagnostics':
          void window.api.invoke('diagnostics:export')
          break
      }
    }

    return (
      <div className="terminal-error-notice" role="status" data-testid="terminal-error-notice">
        <span className="terminal-error-notice__icon" aria-hidden="true">
          <AlertIcon size={14} />
        </span>
        <span className="terminal-error-notice__text">{notice}</span>
        {actions && actions.length > 0 ? (
          <span className="terminal-error-notice__actions">
            {actions.map(action => (
              <Button
                key={action}
                label={ACTION_LABELS[action]}
                size="sm"
                variant="secondary"
                onClick={() => handleAction(action)}
              >
                {ACTION_LABELS[action]}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
    )
  }
)
