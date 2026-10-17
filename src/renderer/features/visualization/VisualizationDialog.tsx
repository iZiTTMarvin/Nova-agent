/**
 * 可视化展开视图：同一快照在更宽的视口中重新挂载一个独立帧。
 * 帧内持有焦点时 Esc 由产物接收，关闭依赖标题栏按钮与遮罩点击。
 */
import React, { useId, useState } from 'react'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import type { VisualizationDocumentStatus, VisualizationTheme } from '../../../shared/visualization'
import { CloseIcon, SpinnerIcon } from '../../components/Icons'
import { VisualizationFrame, type VisualizationFrameHandlers } from './VisualizationFrame'

/** 弹窗外边距与标题栏占用的纵向空间 */
const DIALOG_CHROME_PX = 120
const MIN_EXPANDED_HEIGHT = 240

export interface VisualizationDialogProps
  extends Pick<VisualizationFrameHandlers, 'onAnimated' | 'onRuntimeError' | 'onUserEvent'> {
  uri: string
  title: string
  theme: VisualizationTheme
  motionScale: number
  actions: React.ReactNode
  onClose: () => void
}

export function VisualizationDialog({
  uri,
  title,
  theme,
  motionScale,
  actions,
  onClose,
  onAnimated,
  onRuntimeError,
  onUserEvent
}: VisualizationDialogProps): React.ReactElement {
  const titleId = useId()
  const [maxHeight] = useState(() => Math.max(MIN_EXPANDED_HEIGHT, window.innerHeight - DIALOG_CHROME_PX))
  const [status, setStatus] = useState<VisualizationDocumentStatus | 'loading' | 'timeout'>('loading')

  return (
    <Dialog
      isOpen
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
      purpose="info"
      padding={0}
      width="min(1200px, calc(100vw - 48px))"
      maxHeight="calc(100vh - 48px)"
      className="visualization-dialog"
      aria-labelledby={titleId}
    >
      <header className="visualization-dialog__header">
        <h3 id={titleId} className="visualization-dialog__title">{title}</h3>
        <div className="visualization-card__actions">
          {actions}
          <IconButton label="关闭" icon={<CloseIcon size={16} />} variant="ghost" size="sm" onClick={onClose} />
        </div>
      </header>
      <div className="visualization-dialog__body">
        {status === 'timeout' ? (
          <div className="visualization-card__state">可视化加载超时，关闭后可重新打开。</div>
        ) : (
          <div className="visualization-card__viewport">
            <VisualizationFrame
              uri={uri}
              title={title}
              theme={theme}
              motionScale={motionScale}
              maxHeight={maxHeight}
              onReady={setStatus}
              onTimeout={() => setStatus('timeout')}
              onAnimated={onAnimated}
              onRuntimeError={onRuntimeError}
              onUserEvent={onUserEvent}
            />
            {status === 'loading' && (
              <div className="visualization-card__loading" aria-hidden="true">
                <SpinnerIcon size={15} />
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
