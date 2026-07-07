/**
 * API Key 主进程落盘加密（Electron safeStorage）
 */
import { safeStorage } from 'electron'
import { mainLog } from '../logger'

const ENCRYPTED_PREFIX = 'enc:'

let safeStorageWarned = false

function warnSafeStorageFallback(): void {
  if (safeStorageWarned) return
  safeStorageWarned = true
  mainLog.warn('[apiKeyStorage] safeStorage 不可用，API Key 将明文落盘')
}

/** 加密后落盘（带 enc: 前缀） */
export function encryptApiKeyForDisk(plain: string): string {
  if (!plain) return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      warnSafeStorageFallback()
      return plain
    }
    const buf = safeStorage.encryptString(plain)
    return ENCRYPTED_PREFIX + buf.toString('base64')
  } catch (err) {
    mainLog.error('[apiKeyStorage] 加密失败，回退明文', err)
    return plain
  }
}

/** 从磁盘读取并解密 */
export function decryptApiKeyFromDisk(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      warnSafeStorageFallback()
      return ''
    }
    const buf = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    mainLog.error('[apiKeyStorage] 解密失败', err)
    return ''
  }
}
