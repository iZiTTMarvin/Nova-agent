import type { ModelClient } from '../../model/ModelClient'
import type { LearningZeroModelNavigationView } from '../../../shared/learning/navigation'
import type { KnowledgeTreeProjectionView } from '../../../shared/learning/knowledgeProjection'
import { buildZeroModelNavigation } from '../build/zeroModelNavigation'
import { ProjectKnowledgeReader } from './ProjectKnowledgeReader'

export interface LearningKnowledgeSurfaceView {
  readonly navigation: LearningZeroModelNavigationView
  readonly tree: KnowledgeTreeProjectionView
}

/** 零模型可读：导航与已发布摘要，不调用 chat()。 */
export class LearningKnowledgeSurface {
  constructor(private readonly reader: ProjectKnowledgeReader) {}

  async loadView(workspaceRoot: string): Promise<LearningKnowledgeSurfaceView> {
    const tree = await this.reader.getTreeProjection(workspaceRoot)
    const navigation = await buildZeroModelNavigation({ workspaceRoot, projection: tree })
    return { navigation, tree }
  }

  canUseModel(model: ModelClient | null | undefined): boolean {
    if (!model) return false
    return true
  }
}
