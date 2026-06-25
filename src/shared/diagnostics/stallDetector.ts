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
 * 2. 主进程：事件间隔 stall 检测 —— 在 AgentEvent 流上打时间戳，任意两个相邻
 *    事件间隔超过阈值时打印 [STALL] X → Y，精确框定"卡在哪个事件之间"。
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

// ── 主进程：事件间隔 stall 检测 ──────────────────────────────

/** 触发 stall 告警的事件间隔阈值（ms） */
const STALL_THRESHOLD_MS = 2000

/**
 * 创建一个事件流 stall 检测器。在 AgentEvent 流上调用 markEvent(eventName)，
 * 当两个相邻事件间隔超过阈值时打印 [STALL] X → Y，框定卡顿区间。
 *
 * ⚠️ 重要局限（决定如何正确解读输出）：
 * 父 agent 的 EventBus 在以下「合法空闲」期间会天然静默，间隔不代表卡顿：
 *   - permission_request 之后：在等用户点按钮（任意时长）
 *   - 派 task 子代理期间：父在 await subLoop.sendMessage，子代理的 tool_call/
 *     tool_result 等事件不转发到父 EventBus，父事件流静默到子代理跑完
 *   - 等 LLM 首 token 的网络往返
 *
 * 因此本检测器对这些场景做了抑制（见 USER_WAIT_EVENTS + 子代理运行判定），
 * 但仍可能漏报/误报。**判断主进程是否真正卡死的可靠方法是：看渲染进程 Console
 * 是否同时出现 [longtask]。若 [STALL] 与 [longtask] 同时出现 → 主进程真卡；
 * 若只有 [STALL] → 多半是合法空闲（子代理/等用户/等网络）。**
 *
 * @returns markEvent 函数，传入当前事件名（如 'message_start'）
 */

/** 这些事件之后是在等用户决策，间隔不算 stall（清空计时起点） */
const USER_WAIT_EVENTS = new Set([
  'permission_request',
  'verification_permission_request'
])

export function createEventStallDetector(): (eventName: string) => void {
  let lastEvent: string | null = null
  /** 上一个事件时间戳；null 表示「等待中/无基准」，不参与 stall 判定 */
  let lastTime: number | null = null

  return (eventName: string): void => {
    if (!STALL_DEBUG) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()

    // 当前事件是「等用户决策」类 → 清空计时，下一个事件重新起算
    // （permission_request → tool_result 之间「等用户点按钮」的 N 秒不算 stall）
    if (USER_WAIT_EVENTS.has(eventName)) {
      lastEvent = null
      lastTime = null
      return
    }

    if (lastEvent !== null && lastTime !== null) {
      const dt = now - lastTime
      if (dt >= STALL_THRESHOLD_MS) {
        // eslint-disable-next-line no-console
        console.warn(
          `[STALL] ${lastEvent} → ${eventName} 间隔 ${dt.toFixed(0)}ms。` +
          `注意：若此期间派了子代理/等了用户/等网络首token，这是正常空闲；` +
          `若同时渲染进程Console有[longtask]，才是主进程真卡死。`
        )
      }
    }

    lastEvent = eventName
    lastTime = now
  }
}
