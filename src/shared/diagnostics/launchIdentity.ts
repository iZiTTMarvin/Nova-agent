/** LaunchIdentity — 一次进程启动的无密钥身份 */

/** 构建指纹无法确定时的显式取值；不得用时间戳或版本号冒充。 */
export const UNKNOWN_BUILD_FINGERPRINT = 'unknown'

/** 运行宿主；headless / 单测为 node，桌面主进程为 electron-main */
export type LaunchHost = 'electron-main' | 'node'

export interface LaunchIdentity {
  /** 本次进程启动的唯一 id */
  launchId: string
  /** 应用版本；未知为 'unknown' */
  appVersion: string
  /** 主 bundle 内容指纹；无法读取时为 UNKNOWN_BUILD_FINGERPRINT */
  buildFingerprint: string
  /** 进程启动墙钟 ms */
  startedAt: number
  host: LaunchHost
}

/** 启动身份的初始化输入；未提供的字段按 unknown 记录 */
export interface LaunchIdentityInput {
  appVersion?: string
  buildFingerprint?: string
  host?: LaunchHost
}

let identity: LaunchIdentity | null = null

/** 由宿主在启动早期写入一次。重复调用以首次为准： */
export function initLaunchIdentity(input: LaunchIdentityInput = {}): LaunchIdentity {
  if (identity) return identity
  identity = {
    launchId: globalThis.crypto.randomUUID(),
    appVersion: input.appVersion ?? 'unknown',
    buildFingerprint: input.buildFingerprint ?? UNKNOWN_BUILD_FINGERPRINT,
    startedAt: Date.now(),
    host: input.host ?? detectHost()
  }
  return identity
}

/** 读取当前启动身份；宿主未初始化时按 unknown 惰性建立，不伪造构建指纹。 */
export function getLaunchIdentity(): LaunchIdentity {
  return identity ?? initLaunchIdentity()
}

/** 单测重置：清空进程级身份，使下一个用例重新建立 */
export function resetLaunchIdentityForTests(): void {
  identity = null
}

function detectHost(): LaunchHost {
  try {
    const versions = (process as { versions?: { electron?: string } }).versions
    return versions?.electron ? 'electron-main' : 'node'
  } catch {
    return 'node'
  }
}
