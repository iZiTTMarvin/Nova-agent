import { createContext, useContext } from 'react'
import { submitVisualizationMessage, type VisualizationMessageSubmitter } from './visualizationMessages'

/** 卡片回传消息的去向由宿主表面提供；没有提供者时走开发对话。 */
export const VisualizationMessageContext =
  createContext<VisualizationMessageSubmitter>(submitVisualizationMessage)

export function useVisualizationMessageSubmitter(): VisualizationMessageSubmitter {
  return useContext(VisualizationMessageContext)
}
