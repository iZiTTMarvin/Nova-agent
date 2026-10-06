import React, { useLayoutEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererStallDetector } from '../shared/diagnostics/stallDetector'
import { installPopoverReentrancyGuard } from './installPopoverReentrancyGuard'
import { installWindowStartupSignal } from './installWindowStartupSignal'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import './styles/astryx-parchment.css'
import './styles/global.css'

// 常驻黑匣子：捕获偶发的渲染进程主线程长任务（>500ms），定位卡顿时用。
// 浏览器原生 PerformanceObserver，开销极小，设 NOVA_STALL_DEBUG=0 可静默。
installPopoverReentrancyGuard()
installRendererStallDetector()

function StartupRoot(): React.JSX.Element {
  useLayoutEffect(installWindowStartupSignal, [])
  return <ErrorBoundary><App /></ErrorBoundary>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StartupRoot />
  </React.StrictMode>
)

// diff 运行时（@pierre/diffs + shiki + worker 池）不在首屏加载，
// 由真正渲染 diff 时按需引入，见 features/diff/DiffPoolContextBridge.tsx。
// 这里不做空闲预热：预热会在应用空闲期拉取约 1.2MB 依赖，
// 与「启动期不付这笔成本」的目标相抵，且其收益未实测，故不保留。

