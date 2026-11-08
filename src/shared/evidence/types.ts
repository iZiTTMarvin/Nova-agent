export interface EvidenceBrowserTarget {
  readonly browserId: string
  readonly generation: number
  readonly documentEpoch: number
  readonly url: string
}

interface EvidenceSource {
  readonly sourceTool: string
  readonly description: string
  readonly bytes: number
}

export type EvidenceReference =
  | (EvidenceSource & {
      readonly kind: 'image'
      readonly url: string
      readonly mimeType: string
      readonly width: number
      readonly height: number
      readonly browser?: EvidenceBrowserTarget
    })
  | (EvidenceSource & {
      readonly kind: 'artifact'
      readonly artifactId: string
      readonly mimeType: 'text/plain'
    })

export const EVIDENCE_ARTIFACT_MAX_BYTES = 256_000

export type EvidenceReadResult =
  | { readonly status: 'available'; readonly text: string }
  | { readonly status: 'unavailable'; readonly reason: string }

export function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!value || typeof value !== 'object') return false
  if (!('sourceTool' in value) || typeof value.sourceTool !== 'string' || !value.sourceTool ||
      !('description' in value) || typeof value.description !== 'string' || value.description.length > 2000 ||
      !('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      !('kind' in value)) return false
  const allowed = value.kind === 'artifact'
    ? ['kind', 'sourceTool', 'description', 'bytes', 'artifactId', 'mimeType']
    : ['kind', 'sourceTool', 'description', 'bytes', 'url', 'mimeType', 'width', 'height', 'browser']
  if (Object.keys(value).some(key => !allowed.includes(key))) return false
  if (value.kind === 'artifact') {
    return 'artifactId' in value && typeof value.artifactId === 'string' &&
      /^(?:[a-f0-9]{12}|sha256-[a-f0-9]{64})$/.test(value.artifactId) &&
      'mimeType' in value && value.mimeType === 'text/plain'
  }
  if (value.kind !== 'image' || !('url' in value) || typeof value.url !== 'string' ||
      !/^nova-image:\/\/[A-Za-z0-9_-]+\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(value.url) ||
      !('mimeType' in value) || typeof value.mimeType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(value.mimeType) ||
      !('width' in value) || typeof value.width !== 'number' || !Number.isSafeInteger(value.width) || value.width <= 0 ||
      !('height' in value) || typeof value.height !== 'number' || !Number.isSafeInteger(value.height) || value.height <= 0) return false
  if (!('browser' in value) || value.browser === undefined) return true
  const browser = value.browser
  return !!browser && typeof browser === 'object' &&
    Object.keys(browser).every(key => ['browserId', 'generation', 'documentEpoch', 'url'].includes(key)) &&
    'browserId' in browser && typeof browser.browserId === 'string' && !!browser.browserId &&
    'generation' in browser && typeof browser.generation === 'number' && Number.isSafeInteger(browser.generation) && browser.generation > 0 &&
    'documentEpoch' in browser && typeof browser.documentEpoch === 'number' && Number.isSafeInteger(browser.documentEpoch) && browser.documentEpoch >= 0 &&
    'url' in browser && typeof browser.url === 'string' && /^https?:\/\//.test(browser.url)
}
