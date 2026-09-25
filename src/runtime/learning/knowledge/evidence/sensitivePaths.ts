const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  'id_ed25519',
  '.npmrc'
])

const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

export function isSensitiveRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  const base = normalized.split('/').pop() ?? normalized
  if (SENSITIVE_BASENAMES.has(base)) return true
  const lower = base.toLowerCase()
  return SENSITIVE_SUFFIXES.some(suffix => lower.endsWith(suffix))
}
