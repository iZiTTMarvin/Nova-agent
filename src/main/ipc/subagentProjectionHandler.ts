import {
  SUBAGENT_GET_PROJECTION,
  SUBAGENT_LIST_PROJECTION_SUMMARIES,
  SUBAGENT_LIST_PROJECTIONS
} from '../../shared/ipc/channels'
import { getSubagentProjectionService } from '../services/SubagentProjectionServiceHost'
import { handle } from './secureIpc'

export function registerSubagentProjectionHandler(): void {
  handle(SUBAGENT_LIST_PROJECTIONS, async (_event, params) => {
    return getSubagentProjectionService().listByParentSessionId(params.parentSessionId)
  })

  handle(SUBAGENT_LIST_PROJECTION_SUMMARIES, async (_event, params) => {
    return getSubagentProjectionService().listLightweightByParentSessionIds(params.parentSessionIds)
  })

  handle(SUBAGENT_GET_PROJECTION, async (_event, params) => {
    return getSubagentProjectionService().getByParentToolCallId(
      params.parentSessionId,
      params.parentToolCallId
    )
  })
}
