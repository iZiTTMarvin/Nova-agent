import React, { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatStore } from '../../stores/useChatStore'
import './RecoveryBanner.css'

interface RecoveryBannerProps {
  /** 当前正在生成的消息 ID；无生成中的消息时不展示 */
  messageId: string | null
}

/** 旋转加载指示器（retrying / recovering 共用） */
function SpinnerIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 12" />
    </svg>
  )
}

/** 警告三角（hook_error 用） */
function WarningIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 1.2 13.2 12H.8L7 1.2zm0 3.4a.6.6 0 0 0-.6.6v3.2a.6.6 0 1 0 1.2 0V5.2a.6.6 0 0 0-.6-.6zm0 6.8a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
      />
    </svg>
  )
}

/** Hook 事件名 → 用户可读标签 */
const HOOK_EVENT_LABELS: Record<string, string> = {
  onMessageStart: '消息开始',
  beforeAgentStart: 'Agent 启动前',
  preChat: '对话前',
  context: '上下文构建',
  preToolUse: '工具调用前',
  postToolUse: '工具调用后',
  postMessage: '消息结束后',
  onError: '错误处理',
  onCancel: '取消时'
}

/**
 * RecoveryBanner — Agent 恢复 / Hook 异常状态条
 *
 * 放置位置：输入框正上方（对齐 Cursor / Windsurf / Codex 的 composer 状态条模式），
 * 用户在 Agent 运行期间能一眼看到重试、上下文压缩或 Hook 警告，而不打断消息流阅读。
 */
export const RecoveryBanner: React.FC<RecoveryBannerProps> = ({ messageId }) => {
  const recoveryState = useChatStore(state =>
    messageId ? state.recoveryState[messageId] : undefined
  )
  const recoveryHints = useChatStore(state =>
    messageId ? state.recoveryHints[messageId] : undefined
  )
  const hookErrors = useChatStore(state =>
    messageId ? state.hookErrors[messageId] : undefined
  )

  const latestHint = recoveryHints?.[recoveryHints.length - 1]

  const recoveryBanner = useMemo(() => {
    if (!messageId || !recoveryState) return null

    if (recoveryState.kind === 'retrying') {
      return {
        variant: 'retrying' as const,
        title: `正在重试（${recoveryState.attempt}/${recoveryState.maxAttempts}）`,
        detail: latestHint?.hint ?? recoveryState.lastError
      }
    }

    if (recoveryState.kind === 'recovering') {
      return {
        variant: 'recovering' as const,
        title: '正在压缩上下文',
        detail: latestHint?.hint
      }
    }

    if (recoveryState.kind === 'failed') {
      return {
        variant: 'failed' as const,
        title: 'Agent 已停止',
        detail: latestHint?.hint ?? recoveryState.error
      }
    }

    return null
  }, [messageId, recoveryState, latestHint])

  const hasHookErrors = (hookErrors?.length ?? 0) > 0
  const visible = Boolean(recoveryBanner || hasHookErrors)

  if (!messageId || !visible) return null

  return (
    <div className="recovery-banner-stack" role="status" aria-live="polite">
      <AnimatePresence mode="sync">
        {recoveryBanner && (
          <motion.div
            key={`recovery-${recoveryBanner.variant}`}
            className={`recovery-banner recovery-banner--${recoveryBanner.variant}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18 }}
          >
            <span className="recovery-banner__icon">
              {recoveryBanner.variant === 'failed' ? (
                <WarningIcon />
              ) : (
                <SpinnerIcon className="recovery-banner__spinner" />
              )}
            </span>
            <span className="recovery-banner__body">
              <span className="recovery-banner__title">{recoveryBanner.title}</span>
              {recoveryBanner.detail && (
                <span className="recovery-banner__detail">{recoveryBanner.detail}</span>
              )}
            </span>
          </motion.div>
        )}

        {hookErrors?.map((item, index) => (
          <motion.div
            key={`hook-${item.hookEvent}-${index}`}
            className="recovery-banner recovery-banner--hook-error"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, delay: index * 0.04 }}
          >
            <span className="recovery-banner__icon">
              <WarningIcon />
            </span>
            <span className="recovery-banner__body">
              <span className="recovery-banner__title">
                Hook 异常：{HOOK_EVENT_LABELS[item.hookEvent] ?? item.hookEvent}
              </span>
              <span className="recovery-banner__detail">{item.error}</span>
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
