import { isEvidenceReference, type EvidenceReference } from '../../../shared/evidence'
import type { ImageStore } from '../../storage/ImageStore'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import { assertSideEffectAllowed } from '../types'

export interface PresentEvidenceDeps {
  readonly getReferences: (context: ToolContext) => readonly EvidenceReference[]
  readonly getImageStore: () => ImageStore
}

export function createPresentEvidenceTool(deps: PresentEvidenceDeps): ToolExecutor {
  return {
    name: 'present_evidence',
    description: 'Select existing image or artifact references from tools in this session for delivery. Describe the action and observed result. Evidence existence does not mean verification passed. Never supply file paths, external URLs, session IDs or a verdict.',
    parameters: {
      type: 'object', properties: { items: { type: 'array', minItems: 1, maxItems: 8,
        items: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'artifact'] },
          url: { type: 'string', description: 'For image: nova-image URL returned by a tool' },
          artifactId: { type: 'string', description: 'For artifact: ID returned by a tool' },
          description: { type: 'string', maxLength: 2000 } }, required: ['kind', 'description'], additionalProperties: false } } }, required: ['items'], additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args, context): Promise<ToolResult> {
      try {
        assertSideEffectAllowed(context, '展示证据')
        if (!context.sessionId || !context.sessionStore?.loadMetadata(context.sessionId)) throw new Error('当前会话不存在')
        if (Object.keys(args).some(key => key !== 'items') || !Array.isArray(args.items) || !args.items.length || args.items.length > 8) {
          throw new Error('需要 1–8 项已有证据引用')
        }
        const references = deps.getReferences(context)
        const evidence: EvidenceReference[] = []
        for (const item of args.items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('证据选择无效')
          const input: Record<string, unknown> = item
          const identityKey = input.kind === 'image' ? 'url' : input.kind === 'artifact' ? 'artifactId' : null
          if (!identityKey || Object.keys(input).some(key => !['kind', identityKey, 'description'].includes(key)) ||
              typeof input[identityKey] !== 'string' || typeof input.description !== 'string' ||
              !input.description.trim() || input.description.length > 2000) throw new Error('证据选择无效')
          const reference = references.find(ref => ref.kind === input.kind &&
            (ref.kind === 'image' ? ref.url === input.url : ref.artifactId === input.artifactId))
          if (!reference || !isEvidenceReference(reference)) throw new Error('引用不是当前会话的真实工具产物')
          if (reference.kind === 'image') await deps.getImageStore().resolveEvidence(context.sessionId, reference.url)
          else {
            if (!context.artifactStore) throw new Error('Artifact 存储不可用')
            await context.artifactStore.resolveEvidence(context.sessionId, reference.artifactId, reference.sourceTool)
          }
          evidence.push({ ...reference, description: input.description.trim() })
        }
        assertSideEffectAllowed(context, '展示证据')
        if (!context.sessionStore.loadMetadata(context.sessionId)) throw new Error('当前会话已删除')
        return { success: true, output: '已选择真实产物供查看；产物存在不代表验证通过。', evidence }
      } catch (error) {
        return { success: false, output: '', error: error instanceof Error ? error.message : '证据不可用' }
      }
    }
  }
}
