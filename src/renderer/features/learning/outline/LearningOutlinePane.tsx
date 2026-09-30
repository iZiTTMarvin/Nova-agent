/**
 * Inspector「大纲」页主体：按投影的 build 状态与 tree 渲染无大纲、排队、生成中、
 * 暂停、失败、列表、主题详情。构建状态由主进程调度器唯一写入，这里只读与转发意图。
 */
import { useCallback, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu'
import { MoreIcon, SpinnerIcon } from '../../../components/Icons'
import type { LearningBuildFailureReason, LearningBuildStage } from '../../../../shared/learning/surface'
import { useSettingsStore } from '../../../stores/useSettingsStore'
import { useLearningStore } from '../useLearningStore'
import {
  LEARNING_BUILD_STAGES,
  LEARNING_GO_TO_SETTINGS,
  LEARNING_OUTLINE_CANCEL,
  LEARNING_OUTLINE_EMPTY_TITLE,
  LEARNING_OUTLINE_GENERATE,
  LEARNING_OUTLINE_GENERATE_HINT,
  LEARNING_OUTLINE_LOADING,
  LEARNING_OUTLINE_MENU_LABEL,
  LEARNING_OUTLINE_PAUSED,
  LEARNING_OUTLINE_PAUSED_AUTO,
  LEARNING_OUTLINE_QUEUED,
  LEARNING_OUTLINE_REGENERATE,
  LEARNING_OUTLINE_RESUME,
  LEARNING_OUTLINE_STAGES_LABEL,
  LEARNING_RETRY_LABEL,
  learningBuildFailureCopy
} from '../learningCopy'
import { OutlineList } from './OutlineList'
import { OutlineTopicDetail } from './OutlineTopicDetail'
import '../LearningSurface.css'

function BuildStageIndicator({ stage }: { stage: LearningBuildStage }): React.ReactElement {
  const activeIndex = LEARNING_BUILD_STAGES.findIndex(item => item.stage === stage)
  return (
    <ol className="learning-outline__stages" aria-label={LEARNING_OUTLINE_STAGES_LABEL}>
      {LEARNING_BUILD_STAGES.map((item, index) => (
        <li
          key={item.stage}
          className={`learning-outline__stage${index === activeIndex ? ' learning-outline__stage--active' : ''}`}
          aria-current={index === activeIndex ? 'step' : undefined}
        >
          {index === activeIndex ? (
            <SpinnerIcon size={12} className="learning-outline__stage-spin" aria-hidden="true" />
          ) : (
            <span className="learning-outline__stage-dot" aria-hidden="true" />
          )}
          {item.label}
        </li>
      ))}
    </ol>
  )
}

function BuildFailureBanner({
  reason,
  detail,
  onRetry
}: {
  reason: LearningBuildFailureReason
  detail?: string
  onRetry: () => void
}): React.ReactElement {
  const copy = learningBuildFailureCopy(reason, detail)
  return (
    <Banner
      status="error"
      title={copy.title}
      className="learning-outline__banner"
      endContent={
        copy.action === 'settings' ? (
          <Button
            label={LEARNING_GO_TO_SETTINGS}
            variant="ghost"
            size="sm"
            onClick={() => useSettingsStore.getState().openLlmSettings()}
          />
        ) : copy.action === 'retry' ? (
          <Button label={LEARNING_RETRY_LABEL} variant="ghost" size="sm" onClick={onRetry} />
        ) : undefined
      }
    />
  )
}

export function LearningOutlinePane({ sessionId }: { sessionId: string }): React.ReactElement {
  // 学习 store 还绑在别的会话上时不读投影，避免切换间隙串数据
  const projection = useLearningStore(state => (state.sessionId === sessionId ? state.projection : null))
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null)

  // build 接纳即返回；状态变化经 learning:surface-changed 下发，这里再主动拉一次让反馈即时
  const requestBuild = useCallback(() => {
    void window.api
      .invoke('learning:build', { sessionId })
      .catch(() => {})
      .finally(() => {
        if (useLearningStore.getState().sessionId === sessionId) void useLearningStore.getState().refresh(sessionId)
      })
  }, [sessionId])

  const cancelBuild = useCallback(() => {
    void window.api
      .invoke('learning:cancel-build', { sessionId })
      .catch(() => {})
      .finally(() => {
        if (useLearningStore.getState().sessionId === sessionId) void useLearningStore.getState().refresh(sessionId)
      })
  }, [sessionId])

  if (!projection) {
    return (
      <div className="learning-outline" role="status">
        <p className="learning-outline__state-text">{LEARNING_OUTLINE_LOADING}</p>
      </div>
    )
  }

  const build = projection.build
  const hasOutline = projection.tree.nodes.length > 0
  const detailNode = detailNodeId
    ? projection.tree.nodes.find(node => node.nodeId === detailNodeId) ?? null
    : null

  if (detailNode) {
    return <OutlineTopicDetail sessionId={sessionId} node={detailNode} onBack={() => setDetailNodeId(null)} />
  }

  const statusStrip =
    build.status === 'queued' ? (
      <div className="learning-outline__state">
        <p className="learning-outline__state-text">{LEARNING_OUTLINE_QUEUED}</p>
        <Button label={LEARNING_OUTLINE_CANCEL} variant="ghost" size="sm" onClick={cancelBuild} />
      </div>
    ) : build.status === 'running' ? (
      <div className="learning-outline__state">
        <BuildStageIndicator stage={build.stage} />
        <Button label={LEARNING_OUTLINE_CANCEL} variant="ghost" size="sm" onClick={cancelBuild} />
      </div>
    ) : build.status === 'paused' ? (
      <div className="learning-outline__state">
        <p className="learning-outline__state-text">
          {build.autoResume ? LEARNING_OUTLINE_PAUSED_AUTO : LEARNING_OUTLINE_PAUSED}
        </p>
        {build.autoResume ? (
          <Button label={LEARNING_OUTLINE_CANCEL} variant="ghost" size="sm" onClick={cancelBuild} />
        ) : (
          <Button label={LEARNING_OUTLINE_RESUME} variant="secondary" size="sm" onClick={requestBuild} />
        )}
      </div>
    ) : null

  if (!hasOutline) {
    return (
      <div className="learning-outline">
        {build.status === 'failed' ? (
          <BuildFailureBanner reason={build.reason} detail={build.detail} onRetry={requestBuild} />
        ) : statusStrip ?? (
          <div className="learning-outline__empty">
            <p className="learning-outline__empty-title">{LEARNING_OUTLINE_EMPTY_TITLE}</p>
            <Button label={LEARNING_OUTLINE_GENERATE} variant="primary" size="md" onClick={requestBuild} />
            <p className="learning-outline__empty-hint">{LEARNING_OUTLINE_GENERATE_HINT}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="learning-outline">
      <div className="learning-outline__header">
        <DropdownMenu
          button={{ label: LEARNING_OUTLINE_MENU_LABEL, tooltip: LEARNING_OUTLINE_MENU_LABEL, isIconOnly: true, variant: 'ghost', size: 'sm', icon: <MoreIcon size={14} /> }}
          menuWidth={180}
          items={[{ label: LEARNING_OUTLINE_REGENERATE, onClick: requestBuild }]}
        />
      </div>
      {build.status === 'failed' && (
        <BuildFailureBanner reason={build.reason} detail={build.detail} onRetry={requestBuild} />
      )}
      {statusStrip}
      <OutlineList
        tree={projection.tree}
        nodeProgress={projection.nodeProgress}
        selectedNodeId={projection.selectedNodeId}
        onOpenDetail={setDetailNodeId}
      />
    </div>
  )
}
