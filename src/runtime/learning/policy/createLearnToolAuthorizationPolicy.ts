import type { ToolAuthorizationPolicy } from '../../permissions/PermissionCoordinator'
import {
  isLearnForbiddenTool,
  isLearnVisibleTool
} from '../../../shared/learning/learnToolPolicy'

export function createLearnToolAuthorizationPolicy(): ToolAuthorizationPolicy {
  return toolName => {
    if (isLearnForbiddenTool(toolName)) {
      return { allowed: false, reason: '学习模式不允许该工具' }
    }
    if (isLearnVisibleTool(toolName)) {
      return { allowed: true, reason: '' }
    }
    return { allowed: false, reason: '学习模式未开放该工具' }
  }
}
