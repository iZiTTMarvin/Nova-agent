# Code Index：本地代码结构索引与上下文检索

Code Index 为 Nova 提供可重建的本地代码导航缓存。它把源码中的符号、导入、调用、继承和引用关系整理为带证据的 Context Pack，帮助 Agent 更快定位相关文件；它不替代 `read`，也不把候选关系描述成已经证明的完整调用链或影响范围。

该能力默认关闭。开关在会话创建时快照，已有会话的工具面不会随全局设置变化。

## 架构与状态归属

数据流为：

```text
WorkspaceService
  → CodeGraphHost
  → CodeIndexCoordinator
  → Index Worker
  → SQLite generation/revision
  → CodeGraphEngine
  → code_context
```

- `WorkspaceService` 是当前工作区根目录的唯一写入 Owner。
- `CodeIndexCoordinator` 是索引生命周期、generation、revision、状态和 Worker 调度的唯一写入 Owner。
- Index Worker 独占 SQLite 写连接，负责文件发现、Tree-sitter 解析、确定性关系解析和原子提交。Electron 主线程不会扫描或解析整个项目，也没有主线程降级写路径。打包后优先读取与 Worker 同级的 `code-graph/grammars`；安装包把 WASM 放在 `resources/code-graph/grammars`，避免 asar 再存一份，也不把 headless 评测产物打进桌面安装包。
- 查询端只打开 SQLite 只读连接，并且只读取已经提交的 generation。全量重建不会暴露半完成数据。
- Renderer 只消费带工作区根和单调 sequence 的状态投影，不回写领域状态。状态事件不会进入聊天消息。

索引位于 Nova 用户数据目录的 `code-graph/<workspace-hash>/index.db`。它是缓存，可以安全删除并从源码重建；长期未访问的缓存会按保留期和总容量预算回收，当前活动工作区不会被回收。

## Evidence contract

`code_context` 只接受 `locate`、`understand` 和 `impact`。返回值是单行紧凑 JSON，主要字段依次为状态、revision、摘要、意图、锚点、关系、建议阅读范围、覆盖率和警告。

每条关系都携带：

- `confidence`：证据置信度；
- `resolver`：产生关系的解析器；
- `sourceFile` / `sourceLine`：证据来源；
- `depth`：查询展开深度。

无法唯一解析的关系进入 unresolved 记录。覆盖率不足、动态分派或配置歧义会作为 limitation/warning 返回。`impact` 只给出应继续检查的候选，不能据此声明“没有影响”。Agent 应按 `recommendedReads` 使用 `read` 核对源码；只有真实 `read` 会更新 ReadState。

工具输出目标不超过 6 KiB，硬上限为 12 KiB。超过上下文上限时由统一 OutputSink 归档并返回 `artifact://` 指针，模型可以继续读取完整结果。

## 支持范围

当前结构解析支持：

- TypeScript、TSX、JavaScript、JSX、MJS、CJS；
- Python。

JavaScript/TypeScript 路径解析覆盖相对路径、`tsconfig` / `jsconfig` paths、index 文件、package exports 和基础 ESM/CJS 形式；Python 覆盖绝对与相对 import。解析只读取配置文本，不执行项目代码、脚本或模块，也不会联网下载 grammar。

当前版本不提供 TypeScript Compiler API 语义分析或 `flow` 查询。不能确定唯一目标时保留 unresolved，而不是猜测连接。

## 失败与回退

- 功能关闭：不注册 `code_context`，不启动 watcher/Worker，不打开索引数据库。
- 首次构建：状态为 `building`；聊天和传统 `grep` / `find` / `read` 继续可用。
- 增量更新：查询继续读取 last-good generation，并以 `updating` 提示可能短暂落后。
- 单文件解析失败：其他文件继续，coverage 标记为 partial。
- watcher、Worker、WASM 或 SQLite 失败：状态进入 `degraded` 或 `unavailable`，工具返回可恢复结果；不会在 Electron 主线程同步重建。
- 工作区切换或取消：旧 operation 由 workspace epoch 和 operation fence 阻止提交，watcher、Worker 与等待中的 Promise 随 Host 关闭。

## 与 Code Mode 的关系

Direct presentation 中模型可直接调用 `code_context`。`code-readonly` presentation 中它只通过 `run_code` 的 `tools.code_context` 暴露，嵌套调用仍回到统一 Tool Runtime；后续 `tools.read` 会正常更新 ReadState。索引工具本身不获得写权限。

## 性能与 A/B 方法

索引构建的解析并发最多为 `min(4, cpuCount - 1)`，确保至少保留一个逻辑核给主进程和 Renderer。Worker 空闲 60 秒后自动释放；`workerState=stopped` 表示解析进程已经 dispose，查询仍走主进程只读连接。稳态只保留 watcher 与 SQLite 只读连接；watcher 使用文件系统事件，不轮询。

重量预算以桌面应用不被拖慢为准，需在真实 Electron 上实测：

| 项 | 预算 |
|---|---|
| 功能关闭时的运行时增量 | 0（不注册工具、不起 Worker、不开 watcher、不开 DB） |
| 启用后稳态常驻（Worker 已释放） | ≤ 20 MB |
| 启用后解析中峰值 | ≤ 150 MB |
| 启用后空闲 CPU | 接近 0（仅 watcher 句柄） |
| 中大型仓库 warmed `code_context` p95 | ≤ 150 ms（告警线，不是预期值） |

日常 `npm run test:e2e` 不含重量用例。本地或发布前单独运行：

```bash
npm run test:e2e:code-index-weight
npm run test:headless-code-graph
```

实测数字、安装包增量与语料规模记录在 `docs/Local_Docs/`（不纳入 Git）。以后优化以同一 corpus 的相对回归为准。

Headless 使用显式 `--code-graph` 形成实验臂，baseline 不带该参数。评测配置里两个 Nova 臂共用同一 adapter，只改 `code_graph`：

```json
"nova": { "adapter": "nova", "version": "workspace", "code_graph": false },
"nova_code_index": { "adapter": "nova", "version": "workspace", "code_graph": true }
```

默认 `active_agents` 仍是 `["nova"]`。对照实验需改为 `["nova", "nova_code_index"]`，并把 `pair_concurrency` 设为 `1`。两臂必须保持模型、reasoning effort、稳定提示词、上下文窗口、工具经济策略、轮次和 deadline 一致。`summary.json` 记录：

- `read` / `grep` / `find` / `code_context` 调用次数；
- 总工具调用、模型请求、输入/输出 Token 和耗时；
- 索引状态、revision、查询延迟 p50/p95 和返回锚点数；
- 工具结果累计字节、压缩次数；
- 既有 cache diagnostics 的 tools bytes、expected/actual cache reuse、first diff、失效 Token 估算与 epoch。

可用以下命令比较一对运行。缺指标、任务不一致、稳定提示词不一致或上下文窗口不一致时退出码为 1；工具结果字节或压缩次数上升时退出码为 2：

```bash
npm run code-graph:compare-ab -- \
  --baseline path/to/baseline/summary.json \
  --experiment path/to/experiment/summary.json
```

发布评估应使用多文件 TypeScript/Electron、TypeScript backend 和 Python 任务，并覆盖小、中、大仓库。除任务通过率外，应重点观察传统探索调用是否下降、Token 和缓存命中是否退化，以及工具结果是否让压缩更早发生。
