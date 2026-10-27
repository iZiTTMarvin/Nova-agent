const jsonValueSchema = (): Record<string, unknown> => ({
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: {} },
    { type: 'object' }
  ]
})

const evidenceSchema = {
  type: 'object',
  properties: {
    line: { type: 'number', description: '1-based line in the normalized page content' },
    text: { type: 'string' }
  },
  required: ['line', 'text'],
  additionalProperties: false
}

const fieldResultSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['extracted'] },
        value: jsonValueSchema(),
        confidence: { type: 'number' },
        evidence: evidenceSchema
      },
      required: ['status', 'value', 'confidence'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['uncertain'] },
        guess: jsonValueSchema(),
        confidence: { type: 'number' },
        evidence: evidenceSchema,
        notFound: { type: 'boolean' }
      },
      required: ['status', 'guess'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { status: { type: 'string', enum: ['null'] } },
      required: ['status'],
      additionalProperties: false
    }
  ]
}

const extractionSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['clairic', 'current-model'] },
        fields: {
          type: 'object',
          additionalProperties: fieldResultSchema
        },
        cut: { type: 'boolean' }
      },
      required: ['provider', 'fields', 'cut'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['clairic', 'current-model'] },
        error: { type: 'string' }
      },
      required: ['provider', 'error'],
      additionalProperties: false
    }
  ]
}

const pageMetadata = (kind: 'readable' | 'extract') => ({
  kind: { type: 'string', enum: [kind] },
  requestedUrl: { type: 'string' },
  url: { type: 'string' },
  fromCache: { type: 'boolean' },
  fetchedAt: { type: 'number' }
})

export const WEB_FETCH_CODE_MODE_RESULT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      properties: {
        ...pageMetadata('readable'),
        content: { type: 'string' },
        degraded: { type: 'boolean' }
      },
      required: ['kind', 'requestedUrl', 'url', 'fromCache', 'fetchedAt', 'content', 'degraded'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        ...pageMetadata('extract'),
        contentSha256: { type: 'string' },
        extraction: extractionSchema
      },
      required: ['kind', 'requestedUrl', 'url', 'fromCache', 'fetchedAt', 'contentSha256', 'extraction'],
      additionalProperties: false
    }
  ]
}
