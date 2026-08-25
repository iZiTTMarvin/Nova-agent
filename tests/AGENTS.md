# Nova 测试规则

本目录的目标是用最少、最有信息量的测试保护真实用户行为、关键状态和高风险边界。测试数量、覆盖率数字和是否遵循 TDD 都不是目标。

## 1. 什么时候应该新增测试

不要把“代码有改动”自动等同于“必须新增测试”。新增测试前必须能回答：如果这个测试以后失败，它明确说明哪条用户行为或系统不变量被破坏了？

优先保护：

- run / session / message 等状态 Owner 的合法转移与终态；
- 取消、失败、超时、恢复、乱序、重复事件和 stale result；
- IPC、持久化、协议转换、权限等跨边界契约；
- 曾经发生过且容易复发的回归；
- Renderer 中会造成卡死、无法继续操作、状态串会话或监听器泄漏的生命周期问题；
- 打包后才存在的 preload、asar、资源路径、native dependency 与启动问题。

通常不值得单独新增测试：

- 只证明静态文案、className 或组件“能 render”；
- 与已有测试重复同一断言；
- 只检查 mock 被调用，却没有验证结果或状态；
- 为每个 props 分支机械复制同一种 comparator 测试；
- 把真正的状态 Owner、IPC 或 runtime 全部 mock 掉后再证明“完整链路正确”。

修复缺陷时，优先扩展最接近该风险的现有测试。只有现有测试无法自然表达新的边界时才新增文件。

## 2. 不强制 TDD

Nova 不要求严格执行 Red → Green → Refactor，也不要求 Coding Agent 在实现前机械创建 failing test。

需要先测试再实现的场景，是测试本身能帮助澄清契约、重现回归或固定高风险行为。若需求和边界已经清楚，可以先实现再补必要验证。禁止为了“遵守 TDD”制造低价值测试。

测试代码和生产代码一样有维护成本。删除重复、脆弱、没有保护价值的测试属于正常维护。

## 3. 测试层级怎么选

| 层级 | 主要用途 | 不应用来证明 |
| --- | --- | --- |
| `unit` | 纯规则、状态机、小范围边界、确定性回归 | Electron 真实生命周期、真实 IPC 链路 |
| `integration` | 多个真实模块之间的契约和持久化往返 | 最终桌面用户体验 |
| `e2e/smoke` | 冷启动、已准备会话后的聊天与工具调用 | 极端时序和故障恢复 |
| `e2e/lifecycle` | cancel、切会话、reload、重复 reload 后的 listener 重绑定 | 大规模故障组合 |
| `e2e/weight` | 代码索引稳态/峰值内存与空闲 CPU，需等待真实 Worker 释放 | 日常编辑反馈、普通生命周期 |
| `e2e/fault` | 延迟流、provider 失败、压力；以及 Renderer 对重复/过期/缺口 snapshot 投影的防御 | 每次本地编辑后的快速反馈；RunCoordinator Owner 的完整乱序协议 |
| `e2e/packaged` | 真正打包产物的启动与完整链路 | 日常开发循环 |

Renderer 的“用户点着点着卡死”“runtime 已结束但 UI 仍 running”“切会话后旧事件污染新会话”等问题，优先在真实 Electron E2E 中验证，不用大量 mock 的组件测试代替。

## 4. Electron E2E 的真实性边界

E2E 使用 Playwright 启动真实 Electron。测试从 Renderer 经过 preload、IPC、main、runtime 和 ModelClient，再回到 Renderer。

为了让模型输出可重复，`tests/e2e/fixtures/fake-runtime.ts` 只伪造 OpenAI-compatible HTTP 服务商边界。它不替换 AgentLoop、RunCoordinator、IPC handler、preload 或 Renderer store，也不允许生产代码依赖 test-support。

系统文件选择框等原生 UI 不作为常规 E2E 的操作入口。需要准备工作区时直接走现有类型化 IPC，用户主路径仍通过真实 UI 操作。

每个测试使用隔离的 Electron profile 和临时 workspace，不能读取或污染开发者真实配置与会话。

通用 `nova` fixture 会先写入模型配置并选中临时 workspace，再 reload 一次。这覆盖“已准备会话后的主路径”，不覆盖干净 profile 的首次启动。干净 profile 的窗口、preload 与基础 UI 由 `smoke/cold-start.spec.ts` 验证。

`fault` 里对重复、过期、sequence 缺口 snapshot 的用例，通过已有 `run:snapshot` 事件把载荷送到 Renderer，只检验投影层防御。它们不替换 RunCoordinator，也不给生产 runtime 增加测试后门，因此不能当作 Owner 完整乱序协议测试。

## 5. 开发时怎么跑

先跑受影响的最小集合，不要每编辑一行就跑全量测试。

常用流程：

```text
修改
  ↓
相关 unit / integration
  ↓
继续修改
  ↓
完成当前行为
  ↓
相关回归 + typecheck
  ↓
涉及 Renderer 生命周期时跑对应 Electron E2E
```

命令：

```bash
npm run test -- <相关测试文件>
npm run typecheck

# 首次运行 Electron E2E 时安装独立测试依赖
npm run test:e2e:install

# smoke + lifecycle
npm run test:e2e

# 代码索引重量预算（真实 Worker 空闲释放，不纳入日常 smoke/lifecycle）
npm run test:e2e:code-index-weight

# 故障注入
npm run test:e2e:fault

# 较长的随机生命周期压力
npm run test:e2e:stress

# Windows 打包产物
npm run test:e2e:packaged

# 真实 API 缓存门禁（key 门控、会花钱；无 key 的 provider 自动跳过）
LIVE_CACHE_DEEPSEEK_API_KEY=sk-... npm run test:live-cache
```

全量 Vitest、完整 Electron E2E、fault/stress 和 packaged gate 由 CI / nightly / release 承担。任务完成前仍要运行与本次影响范围直接相关的回归，不能用“CI 会跑”跳过必要验证。

## 6. E2E 目录职责

```text
tests/e2e/
├─ fixtures/
│  ├─ fake-runtime.ts       # 确定性的 OpenAI-compatible HTTP fake
│  └─ nova.ts               # Electron 启动、隔离 profile、诊断与公共操作
├─ smoke/
│  ├─ cold-start.spec.ts
│  ├─ startup.spec.ts
│  ├─ chat.spec.ts
│  ├─ tool-call.spec.ts
│  └─ xforge.spec.ts         # XForge 六阶段：计划硬门、手动批准与阶段闭环
├─ lifecycle/
│  ├─ abort.spec.ts
│  ├─ session-switch.spec.ts
│  ├─ renderer-reload.spec.ts
│  ├─ renderer-reload-rebind.spec.ts
│  └─ code-index.spec.ts     # 首次构建不阻断聊天、切工作区、删最后会话
├─ weight/
│  └─ code-index-weight.spec.ts  # 稳态/峰值内存与空闲 CPU；需等待 Worker 释放
├─ fault/
│  ├─ delayed-events.spec.ts
│  ├─ duplicate-events.spec.ts
│  ├─ out-of-order.spec.ts
│  ├─ runtime-failure.spec.ts
│  └─ stress.spec.ts
└─ packaged/
   └─ release.spec.ts
```

另有一个独立于上述目录的真实 API 门禁：

```text
tests/live/
├─ gate.ts                   # provider 矩阵、捕获型客户端、AgentLoop 装配
├─ prefixCache.spec.ts       # 主请求前缀命中（多步工具 turn + 追问）
├─ compactionCache.spec.ts   # 压缩摘要调用与压缩后主请求命中
└─ README.md                 # 环境变量与运行方式
```

`tests/live` 用 headless 运行时驱动真实 AgentLoop 与真实模型 API，验证服务端前缀缓存命中；key 门控（无 key 跳过）、显式运行（`npm run test:live-cache`）、会花钱，默认套件与 CI 必跑项均不包含。

`smoke` 必须快且稳定；其中 `xforge.spec.ts` 覆盖 XForge 六阶段主流程、计划硬门、手动批准与阶段闭环。`lifecycle` 验证真实桌面状态恢复。`fault` 可以更重，但故障必须可重复，随机测试要固定 seed 并在失败时输出 seed。`packaged` 只验证构建产物特有风险，不复制整套 smoke。

## 7. 失败时留下什么

Electron E2E 失败时应至少保留：

- Playwright trace；
- Renderer screenshot；
- Renderer console / page error；
- Electron main process console。

不要为了让 CI 变绿给异步测试随意增加 sleep、retry 或超大 timeout。先找到可观察的状态或权威 snapshot，再等待那个条件。
