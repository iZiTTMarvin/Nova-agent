/**
 * Composer 内联轻提示横幅：替代阻塞式 window.alert，
 * 贴合在输入框上方展示配置缺失或附件校验提示，并支持自动消退与手动关闭。
 */
import React from 'react'

export interface ComposerNotice {
  message: string
  tone: 'warning' | 'error'
}

export interface ComposerNoticeBannerProps {
  notice: ComposerNotice | null
  onDismiss: () => void
}

export const ComposerNoticeBanner: React.FC<ComposerNoticeBannerProps> = ({
  notice,
  onDismiss
}) => {
  if (!notice) return null

  return (
    <div
      className={`composer-notice-banner composer-notice-banner--${notice.tone}`}
      role="status"
      aria-live="polite"
    >
      <span className="composer-notice-banner__dot" aria-hidden="true" />
      <span className="composer-notice-banner__text">{notice.message}</span>
      <button
        type="button"
        className="composer-notice-banner__dismiss"
        aria-label="关闭提示"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}
