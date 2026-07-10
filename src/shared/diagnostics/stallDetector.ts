/**
 * stallDetector — 偶发卡顿的常驻"黑匣子"监测
 *
 * 背景（2026-06-25）：
 *   nova-agent 出现"派子代理 / 跑命令时偶发卡死数秒~十数秒"的问题。
 *   该卡顿**无法稳定复现**（同输入时有时无），静态分析两轮（正则回溯、snapshot
 *   全量读）均被实测推翻。结论：只有"下次卡顿时自动留下证据"才能定位。
 *
 * 本模块提供两类常驻、低开销监测，定位完根因后可整体移除，不影响任何行为：
 *
 * 1. 渲染进程：PerformanceObserver longtask —— 任何 > 500ms 的主线程长任务
 *    自动 console.warn（浏览器原生 API，零侵入，生产环境也安全）。
 * 2. 主进程：RunCoordinator 驱动的 stall 检测 —— 只在 status===running 且
 *    事件间隔超时时报 [STALL]。waiting_user（权限 / askQuestion /
 *    composeAskUser）与终态一律不算 stall，避免误报。
 *
 * 两者对照即可区分：卡的是主进程（agent 循环）还是渲染进程（UI）。
 *
 * 开关：所有输出由环境变量 NOVA_STALL_DEBUG 控制（默认开启 longtask，主进程
 * stall 默认阈值 2000ms）。设 NOVA_STALL_DEBUG=0 可完全静默。
 */

// 安全读取环境变量：渲染进程（Vite）无 process 对象，主进程有。
// shared 模块不能假设 process 存在，否则模块加载即抛 ReferenceError 白屏。
function readEnv(name: string): string | undefined {
  try {
    return (typeof process !== 'undefined' && process.env?.[name]) || undefined
  } catch {
    return undefined
  }
}

const STALL_DEBUG = readEnv('NOVA_STALL_DEBUG') !== '0'

// ── 渲染进程：longtask 监测 ──────────────────────────────────

/**
 * 在渲染进程启动 longtask 监测。应在 renderer 入口（main.tsx）尽早调用。
 *
 * 使用 PerformanceObserver（浏览器原生）捕获所有 > 50ms 的 longtask entry，
 * 对超过 LONGTASK_WARN_MS 的额外 console.warn。开销极小，Chromium 内部本就在
 * 记录这些 entry，Observer 只是订阅。
 *
 * 幂等：重复调用安全（内部用标志位防止重复订阅）。
 */
let rendererInstalled = false
const LONGTASK_WARN_MS = 500

export function installRendererStallDetector(): void {
  if (rendererInstalled) return
  // 仅在浏览器环境运行（测试环境 / SSR 无 PerformanceObserver）
  if (typeof PerformanceObserver === 'undefined') return
  if (!('performance' in globalThis)) return

  try {
    const observer = new PerformanceObserver((list) => {
      if (!STALL_DEBUG) return
      for (const entry of list.getEntries()) {
        if (entry.duration >= LONGTASK_WARN_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[longtask] ${entry.duration.toFixed(0)}ms @ ${entry.startTime.toFixed(1)} ` +
            `(主线程被同步任务占满，界面会冻住)`
          )
        }
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
    rendererInstalled = true
  } catch {
    // 某些环境不支持 longtask entry type，静默降级
  }
}

// ── 主进程：RunCoordinator 驱动的 stall 检测 ─────────────────

/** 触发 stall 告警的事件间隔阈值（ms） */
const STALL_THRESHOLD_MS = 2000

/** RunCoordinator 提供的 liveness 快照（避免 detector 依赖 Electron） */
export interface StallRunLiveness {
  status: string
  lastHeartbeatAt: number
  /** true = 处于 running，超时未心跳才应告警 */
  expectHeartbeat: boolean
}

export interface EventStallDetectorOptions {
  /**
   * 查询当前 run 的权威状态。由 RunCoordinator.getStallLiveness 注入。
   * 未注入时退化为「仅按事件间隔」旧行为（测试兼容）。
   */
  getRunLiveness?: () => StallRunLiveness | null
  /** 覆盖默认阈值（测试用） */
  thresholdMs?: number
  /** 覆盖 now（测试用）；须与 Date.now 同量纲 */
  now?: () => number
}

/**
 * 创建一个事件流 stall 检测器。
 *
 * 阶段 6：不再用 USER_WAIT_EVENTS 白名单猜「等用户」。
 * 权威规则：仅当 RunCoordinator 报告 expectHeartbeat（status===running）
 * 且相邻 markEvent 间隔超过阈值时打印 [STALL]。
 * waiting_user / retrying / cancelling / 终态 → 静默并清空计时基准。
 *
 * @returns markEvent 函数，传入当前事件名（如 'message_start'）供日志上下文
 */
export function createEventStallDetector(
  options?: EventStallDetectorOptions
): (eventName: string) => void {
  const threshold = options?.thresholdMs ?? STALL_THRESHOLD_MS
  const nowFn = options?.now ?? (() => Date.now())
  let lastEvent: string | null = null
  /** 上一次 markEvent 的墙钟时间（仅 running 期间有效） */
  let lastMarkAt: number | null = null

  return (eventName: string): void => {
    if (!STALL_DEBUG) return
    const now = nowFn()

    const liveness = options?.getRunLiveness?.() ?? null
    if (liveness) {
      // 权威路径：只发现「running 且事件间隔超时」
      if (!liveness.expectHeartbeat) {
        // waiting_user / 终态：清空基准，避免把合法等待时长算进 stall
        lastEvent = null
        lastMarkAt = null
        return
      }
      if (lastMarkAt !== null) {
        const gap = now - lastMarkAt
        if (gap >= threshold) {
          // eslint-disable-next-line no-console
          console.warn(
            `[STALL] run status=${liveness.status} 自上次事件 ` +
            `${gap.toFixed(0)}ms 无进展（${lastEvent ?? '?'} → ${eventName}）。` +
            `若同时渲染进程 Console 有 [longtask]，才是主进程真卡死。`
          )
        }
      }
      lastEvent = eventName
      lastMarkAt = now
      return
    }

    // 退化路径（无 getRunLiveness）：保留事件间隔检测，供单测
    if (lastEvent !== null && lastMarkAt !== null) {
      const dt = now - lastMarkAt
      if (dt >= threshold) {
        // eslint-disable-next-line no-console
        console.warn(
          `[STALL] ${lastEvent} → ${eventName} 间隔 ${dt.toFixed(0)}ms。` +
          `注意：未接入 RunCoordinator 时无法区分合法等待与真卡顿。`
        )
      }
    }

    lastEvent = eventName
    lastMarkAt = now
  }
}
