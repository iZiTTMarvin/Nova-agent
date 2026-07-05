/**
 * ToolBox — 兼容出口
 *
 * 工具过程区已统一为 L3 ToolTraceRow。本文件保留旧名 re-export，
 * 避免历史测试与外部引用立刻断裂。
 */
export {
  ToolTraceRow as ToolBox,
  LIVE_ENTER_SPRING,
  NO_ANIMATION,
  type ToolTraceRowProps as ToolBoxProps
} from './ToolTraceRow'
