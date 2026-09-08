/**
 * compose 五阶段指南：每轮 user 消息尾部注入当前阶段指南。
 * 指南只写「做什么、做到什么算完、怎么交接」；
 * 指南中的工具边界必须与 shared/composeLifecycle/stageToolGating 的门禁矩阵保持一致。
 */
import { COMPOSE_STAGE_LABELS, type ComposeStageId } from '../../../../shared/composeLifecycle'
import interviewGuide from './interview.md?raw'
import blueprintGuide from './blueprint.md?raw'
import buildGuide from './build.md?raw'
import inspectGuide from './inspect.md?raw'
import deliverGuide from './deliver.md?raw'

const GUIDES: Record<ComposeStageId, string> = {
  interview: interviewGuide,
  blueprint: blueprintGuide,
  build: buildGuide,
  inspect: inspectGuide,
  deliver: deliverGuide
}

/** 当前阶段指南文本；统一带阶段标题前缀，让模型明确这是阶段指南而非用户输入 */
export function getComposeStageGuide(stageId: ComposeStageId): string {
  return `[当前阶段: ${COMPOSE_STAGE_LABELS[stageId]} — 阶段指南]\n${GUIDES[stageId].trim()}`
}
