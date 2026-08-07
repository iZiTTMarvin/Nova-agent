/**
 * compose 六阶段指南：每轮 user 消息尾部注入当前阶段指南。
 * 指南只写「做什么、做到什么算完」，不规定步骤；
 * 指南中的工具边界必须与 shared/composeLifecycle/stageToolGating 的门禁矩阵保持一致。
 */
import { COMPOSE_STAGE_LABELS, type ComposeStageId } from '../../../../shared/composeLifecycle'
import brainstormGuide from './brainstorm.md?raw'
import planGuide from './plan.md?raw'
import implementGuide from './implement.md?raw'
import verifyGuide from './verify.md?raw'
import reviewGuide from './review.md?raw'
import reportGuide from './report.md?raw'

const GUIDES: Record<ComposeStageId, string> = {
  brainstorm: brainstormGuide,
  plan: planGuide,
  implement: implementGuide,
  verify: verifyGuide,
  review: reviewGuide,
  report: reportGuide
}

/** 当前阶段指南文本；统一带阶段标题前缀，让模型明确这是阶段指南而非用户输入 */
export function getComposeStageGuide(stageId: ComposeStageId): string {
  return `[当前阶段: ${COMPOSE_STAGE_LABELS[stageId]} — 阶段指南]\n${GUIDES[stageId].trim()}`
}
