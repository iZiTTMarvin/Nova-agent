import React from 'react'
import ReactDOM from 'react-dom/client'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffWorkerUrl from '@pierre/diffs/worker/worker.js?worker&url'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererStallDetector } from '../shared/diagnostics/stallDetector'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import './styles/astryx-parchment.css'
import './styles/global.css'

// 常驻黑匣子：捕获偶发的渲染进程主线程长任务（>500ms），定位卡顿时用。
// 浏览器原生 PerformanceObserver，开销极小，设 NOVA_STALL_DEBUG=0 可静默。
installRendererStallDetector()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <WorkerPoolContextProvider
        poolOptions={{
          poolSize: 2,
          workerFactory: () => new Worker(DiffWorkerUrl, { type: 'module' })
        }}
        highlighterOptions={{
          theme: { light: 'pierre-light', dark: 'pierre-dark' },
          lineDiffType: 'word-alt',
          preferredHighlighter: 'shiki-wasm'
        }}
      >
        <App />
      </WorkerPoolContextProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
