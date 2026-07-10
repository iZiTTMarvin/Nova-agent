# Renderer / Electron 性能门禁

## 为何需要本套件

`tests/unit/renderer/phase3Performance.test.ts` 使用 **ReactTestRenderer**（无真实 DOM / 无 Chromium layout）：

- 通过时仍可能伴随「DOM 缺失 / detached tree」类噪音，测的是 store 更新与虚拟 React 树 commit，**不能**证明真实 Electron Renderer「不卡」。
- 无 PerformanceObserver longtask、无真实 heap、无虚拟列表真实挂载测量。

本目录提供：

1. **可运行 harness**（`rendererPerfHarness.test.ts`）：增量 Markdown 成本趋势 + 预算断言接口 + 消息历史 fixture。
2. **预算 API**（`perfBudget.ts`）：commit p50/p95/p99、longtask、heap 增长断言；CI 可调环境变量。
3. **CI 入口**：`npm run test:perf`。

## 后续扩展（完整 Electron E2E）

在已有预算接口上接入 Playwright + Electron：

1. 启动 `electron-vite` / 打包后的 app。
2. 回放 `buildDeltaTrace(10_000|100_000)` 与 `buildMessageHistoryFixture(500|2000)`。
3. 用 CDP `Performance` / React Profiler / `performance.memory` 填入 `PerfSampleReport`。
4. 调用 `assertPerfBudget`；失败则非零退出。

当前骨架保证门禁脚本与断言契约先落地，避免「只有假绿的 TestRenderer 门禁」。
