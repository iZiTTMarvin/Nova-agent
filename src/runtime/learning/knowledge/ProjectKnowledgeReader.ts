import type { LearningDbWorkerClient } from '../storage/LearningDbWorkerClient'
import type { LearningDbWorkerOp } from '../storage/workerCommand'
import type {
  KnowledgeNodeMaterialView,
  KnowledgeTreeProjectionView
} from '../../../shared/learning/knowledgeProjection'

export class ProjectKnowledgeReader {
  constructor(private readonly client: LearningDbWorkerClient) {}

  getCurrentKnowledgeRevision(workspaceRoot: string): Promise<string | null> {
    const command: LearningDbWorkerOp = {
      domain: 'knowledge',
      op: 'get_current_revision',
      workspaceRoot
    }
    return this.client.invoke<{ revision: string | null }>(command).then(r => r.revision)
  }

  getTreeProjection(workspaceRoot: string): Promise<KnowledgeTreeProjectionView> {
    const command: LearningDbWorkerOp = {
      domain: 'knowledge',
      op: 'get_tree_projection',
      workspaceRoot
    }
    return this.client.invoke(command)
  }

  getNodeMaterial(
    workspaceRoot: string,
    nodeId: string
  ): Promise<KnowledgeNodeMaterialView | null> {
    const command: LearningDbWorkerOp = {
      domain: 'knowledge',
      op: 'get_node_material',
      workspaceRoot,
      nodeId
    }
    return this.client.invoke(command)
  }
}
