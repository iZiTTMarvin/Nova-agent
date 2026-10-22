import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'
import type { VisualizationMessageSubmitter } from '../visualization/visualizationMessages'
import { useLearningStore } from './useLearningStore'
import {
  LEARNING_VIZ_AWAITING_NOTICE,
  LEARNING_VIZ_BUSY_NOTICE,
  LEARNING_VIZ_FAILED_NOTICE
} from './learningCopy'

/**
 * 学习会话里可视化卡片的回传：空闲时作为普通提问进入学习命令管线。
 * 学习命令没有排队，草稿属于用户，所以待答题与生成中只提示、不发送、不改草稿。
 */
export function createLearningVisualizationSubmitter(sessionId: string): VisualizationMessageSubmitter {
  return async text => {
    const learning = useLearningStore.getState()
    const projection = learning.sessionId === sessionId ? learning.projection : null
    const current = projection?.questions.find(question => question.checkpointId === projection.currentCheckpointId)
    if (current?.state === 'awaiting_answer') {
      return { status: 'blocked', notice: LEARNING_VIZ_AWAITING_NOTICE }
    }
    if (learning.commandPending || selectSessionIsRunning(useRunStore.getState(), sessionId)) {
      return { status: 'blocked', notice: LEARNING_VIZ_BUSY_NOTICE }
    }
    const receipt = await learning.sendCommand({ sessionId, action: { type: 'message', text } })
    return receipt?.ok ? { status: 'sent' } : { status: 'blocked', notice: LEARNING_VIZ_FAILED_NOTICE }
  }
}
