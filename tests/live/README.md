# 真实 API 缓存门禁（tests/live）

显式运行、key 门控、**会花钱**的真实 API 回归门禁。默认 `npm test` 与 CI 必跑项均不包含本目录；无 key 的 provider 自动跳过，不报错。

## 运行方式

```bash
# 单个 provider
LIVE_CACHE_DEEPSEEK_API_KEY=sk-... npm run test:live-cache

# 全部已配置 key 的 provider（PowerShell 用 $env: 前缀设置变量）
npm run test:live-cache
```

## 环境变量

每个 provider 支持三个变量，`<ID>` 取 `DEEPSEEK` / `GLM` / `KIMI` / `MINIMAX`：

| 变量 | 说明 |
| --- | --- |
| `LIVE_CACHE_<ID>_API_KEY` | 必填；未设置时该 provider 的用例跳过 |
| `LIVE_CACHE_<ID>_BASE_URL` | 可选；缺省 deepseek/glm/minimax 用注册表预设端点，kimi 用本目录登记的官方端点 |
| `LIVE_CACHE_<ID>_MODEL` | 可选；缺省同上（预设默认模型 / kimi 官方默认模型） |

## 覆盖的缓存机制

| Provider | 档案 | 验证机制 |
| --- | --- | --- |
| DeepSeek | deepseek | 被动前缀缓存 + tool-call reasoning 回放 |
| GLM | glm | 被动前缀缓存 + all-history reasoning 回放 |
| Kimi | kimi | 会话路由 key（prompt_cache_key）+ all-history 回放 |
| MiniMax | minimax | 被动前缀缓存 + think-tag reasoning 回放 |

## 场景

- `prefixCache.spec.ts`：多步工具 turn（真实 read 工具读 fixture 文件）+ 追问一轮；断言首轮之后每个主请求 `cacheRead > 0`。
- `compactionCache.spec.ts`：约 8K 上下文窗口让压缩在数轮内触发；按用途标记识别摘要调用，断言摘要调用与压缩后主请求 `cacheRead > 0`。

失败输出包含每次请求的序号、用途、消息数与归一化 usage（promptTokens / cacheRead / uncachedInput），可直接定位是哪次请求、哪项指标失败。门禁不依赖 sleep 或重试换绿：等待全部通过 `sendMessage` 的权威终态完成。

## 记忆效用与快照对照

`memoryUtility.spec.ts` 默认六个文件修改任务、每个任务两轮，比较 `off`（无记忆工具/快照）、`tool`（按需工具）、`snapshot`（一次开局快照加相同记忆工具）。三组使用相同任务和模型设置，顺序轮换以减少固定执行顺序影响；这是小样本机制与效用检查，不是统计显著性证明。

每个任务的 JSON 保存实际文件是否正确、完成状态、工具调用、模型与传输消息、完整前缀断裂位置、输入 token、累计缓存命中率和各 turn 首请求 usage。未报告缓存量时命中率记为 null，并记录 usage/cache 覆盖数，不能当成 0 命中。`tool`、`snapshot` 的完整前缀断裂要求为 0；快照组还验证系统内容稳定。

先做无网络的脚本类型检查：

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --project tests/live/tsconfig.memory.json
```

**以下命令会付费，只有用户明确授权后运行。** 使用已安全配置的 `MEMORY_AB_API_KEY`、`MEMORY_AB_BASE_URL`、`MEMORY_AB_MODEL`；不要把真实 key 写入命令、结果或仓库。脚本仍沿用既有模型和推理设置，改变供应商或配置需要明确对应实验条件。

```powershell
$env:MEMORY_AB_ARMS = 'off,tool,snapshot'
$env:MEMORY_AB_CASES = '6'
$env:MEMORY_AB_HISTORY_LINES = '0'
$env:MEMORY_AB_OUTPUT_DIR = 'docs/Local_Docs/评估报告/2026-10-08-记忆Markdown化-真实模型'
try {
  npm run rebuild:native:node
  if ($LASTEXITCODE -ne 0) { throw 'Node ABI rebuild failed' }
  npm run test:live-cache -- tests/live/memoryUtility.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Memory utility evaluation failed' }
} finally {
  npm run rebuild:native:electron
  if ($LASTEXITCODE -ne 0) { throw 'Electron ABI restore failed' }
}
```

不得用无 key 时的 skip 结果声称评测通过。先确认 JSON 中确有三个组各六个任务和两轮请求，再按组汇总文件正确数/6、工具调用总数、前缀断裂总数、usage 覆盖率及 token 加权缓存命中率，保留每个任务的失败。首请求与各 turn 首请求应分别报告；新增快照可能增加首请求输入，不能只报告累计缓存比率。

`MEMORY_AB_ARMS=ephemeral` 可显式复现历史临时注入负向对照；`MEMORY_AB_EXTRACT_SEEDS=1` 会额外调用真实提炼模型，费用和任务口径都不同，不属于上述默认三组命令。更多历史上下文可用 `MEMORY_AB_HISTORY_LINES` 单独控制并报告，避免混合不同输入规模。

评测复用 headless 的环境代理适配器：需要代理出网时设置 `HTTPS_PROXY`（或 `HTTP_PROXY`），`NO_PROXY` 沿用已有规则。Node 全局 fetch 不自动使用 Windows 系统代理；先用无认证请求检查 TLS 连接，再运行付费任务。代理和 key 均应仅设置于测试进程，报告记录网络条件但不记录认证信息。
