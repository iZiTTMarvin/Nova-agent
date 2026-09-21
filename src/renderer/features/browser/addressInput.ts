import { parseBrowserHttpUrl } from '../../../shared/browser'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function composeBrowserNavigationUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const direct = parseBrowserHttpUrl(trimmed)
  if (direct) return direct
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null
  const host = trimmed.split('/')[0]?.split(':')[0]?.toLowerCase() ?? ''
  const protocol = LOOPBACK_HOSTS.has(host) ? 'http' : 'https'
  return parseBrowserHttpUrl(`${protocol}://${trimmed}`)
}

export function shouldCommitAddressKey(event: {
  key: string
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.isComposing || event.nativeEvent?.isComposing) return false
  return true
}
