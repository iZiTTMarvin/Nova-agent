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
