/**
 * 注册表 API Key 加解密桥接（由主进程启动时注入 safeStorage 实现）
 */
import type { LlmRegistry } from '../../shared/config/llmRegistry'

type CryptoFn = (value: string) => string

let encryptFn: CryptoFn | null = null
let decryptFn: CryptoFn | null = null

/** 主进程启动时绑定加解密实现；未绑定时明文透传（单测路径） */
export function bindRegistryApiKeyCrypto(encrypt: CryptoFn, decrypt: CryptoFn): void {
  encryptFn = encrypt
  decryptFn = decrypt
}

function encryptKey(key: string): string {
  return encryptFn ? encryptFn(key) : key
}

function decryptKey(stored: string): string {
  return decryptFn ? decryptFn(stored) : stored
}

/** 写盘前：加密所有 provider 的 apiKey */
export function encryptRegistryForDisk(registry: LlmRegistry): LlmRegistry {
  return {
    ...registry,
    providers: registry.providers.map(p => ({
      ...p,
      apiKey: encryptKey(p.apiKey)
    }))
  }
}

/** 读盘后：解密所有 provider 的 apiKey */
export function decryptRegistryFromDisk(registry: LlmRegistry): LlmRegistry {
  return {
    ...registry,
    providers: registry.providers.map(p => ({
      ...p,
      apiKey: decryptKey(p.apiKey)
    }))
  }
}
