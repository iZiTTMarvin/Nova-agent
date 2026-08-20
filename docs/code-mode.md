# Code Mode：只读代码探索沙箱

Code Mode 解决「模型如何高效连续使用工具」：把高频的 `LLM → grep → LLM → read → LLM` 机械往返压缩为一次 `run_code` 调用，中间工具结果留在沙箱内，只有整理后的输出进入主上下文。

当前为**只读探索实验**（`code-readonly`），默认关闭（`direct`）。

## 形态

```text
Tool Catalog（codeMode 嵌套策略）
    ↓
Mode Visibility → Tool Availability（第一部分）
    ↓
Tool Presentation（direct / code-readonly）
    ├─ direct（默认）：run_code 不出现，全部工具原生直调，行为与历史一致
    └─ code-readonly（实验）：
        ├─ ls / read / grep / find 从直调面移除
        ├─ run_code 进入模型可见面
        └─ system prompt 注入确定性生成的 TypeScript SDK 声明
```

- 呈现模式由内部环境变量 `NOVA_TOOL_PRESENTATION=code-readonly` 开启，进程级确定、会话内稳定（避免请求形态抖动破坏前缀缓存）。
- SDK 绑定 = Catalog `codeMode=nestable-readonly` ∩ 当前激活集（投影顺序：Mode → Availability → Nesting），未激活的 deferred 工具不会经 SDK 偷偷出现。

## 安全模型

```text
Electron Main
    ↓ worker_threads（进程级复用一个 worker，每次 run_code 创建全新 QuickJS context）
QuickJS / WASM 沙箱（singlefile 内联 WASM，无外部 .wasm 依赖）
    ↓ 唯一能力入口：tools.<name>(args) / console.log / return
Tool Bridge（消息协议 + SharedArrayBuffer 中止标志）
    ↓
统一 Tool Runtime 执行流水线（可用性闸门 → 权限 → 取消 → 截断 → 诊断）
```

- 沙箱内只有 QuickJS 标准库；`require` / `process` / `fs` / `network` / `electron` 一律不可达，`new Function` 也无法触及宿主作用域。
- 嵌套工具调用**必须**重入统一执行流水线（`ToolContext.dispatchNestedToolCall` → `executeToolBatch`），禁止直调 `tool.impl`；嵌套执行自身不再携带派发入口（防递归）。
- 中止：主线程写 SharedArrayBuffer 原子标志，沙箱中断器同步读取，可打断阻塞中的同步循环；结果超时未回时强杀 worker。
- worker 内执行串行排队，避免多个 WASM 堆同时占用主进程资源；因此当前实验不适合跨会话并发跑多个长 `run_code`，该限制必须纳入真实 A/B 的 latency 评估。
- 资源上限（`src/runtime/code-mode/limits.ts`）：源码 64KB、整体 30s、工具调用 32 次、并发 4、单次入参/输出 512KB、回传模型 64KB、沙箱堆 128MB。

## 输出规则

- 模型只获得 `console.log` 输出与 `return` 值（curated output），中间变量与工具原文留在沙箱。
- 嵌套工具结果 `modelVisibility=hidden`：不写入主对话历史；tool_call / tool_result 事件带 `parentToolCallId` 供 UI 与诊断观测，持久化层跳过嵌套事件（不产生孤儿卡片）。
- curated output 仍走既有 Tool Result 大小管理（maxResultSizeChars 截断），不建第二套大输出存储。
- 失败分类：`parse_error` / `execution_error` / `unknown_tool` / `limit_exceeded` / `tool_failure` / `aborted`；文案面向模型自我修正，明细留在诊断。

## 关键位置

```text
src/runtime/code-mode/
├── types.ts               # CodeRuntime 契约（与 Catalog/Permission 解耦）
├── limits.ts              # 资源上限
├── errors.ts              # 失败文案
├── presentation.ts        # 呈现模式解析 + 投影
├── toolBindings.ts        # SDK 绑定解析（Catalog ∩ 激活集）
├── sdkPrompt.ts           # SDK 声明生成（字节级稳定）
├── textBytes.ts           # UTF-8 字节预算截断（沙箱回传与 curated output 共用）
└── quickjs/
    ├── QuickJsSandboxHost.ts   # 沙箱宿主循环（可进程内测试）
    ├── QuickJsCodeRuntime.ts   # Worker 承载实现 + 进程内实现
    ├── codeModeWorker.ts       # worker_threads 入口（构建为 out/main/codeModeWorker.js）
    ├── protocol.ts             # 主线程 ↔ worker 消息协议
    └── quickJsModule.ts        # WASM 模块懒加载单例

src/runtime/tools/runCode/       # run_code 工具（绑定解析 + 嵌套桥 + curated output）
```

## 上线门槛（未完成项）

正确性门槛已由测试覆盖（`tests/unit/runtime/code-mode/`、`tests/unit/runtime/agent/runCodeIntegration.test.ts`、`nestedToolDispatch.test.ts`）。Performance（LLM request count ≥20% 下降）与 Quality（pass rate 非劣）需要真实模型 A/B（Direct exploration vs Code exploration），在实验模式默认关闭的前提下另行评估；数据不足前保持 `direct`。
