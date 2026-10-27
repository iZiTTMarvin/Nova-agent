# 联网搜索与网页读取

Nova 默认提供联网搜索，无需先填写搜索 API Key。可以直接要求：

> 搜索 TypeScript 官方文档，读取类型收窄章节，并给出来源。

> 查找近一周的 Node.js 官方发布信息，区分发布日期和网页抓取日期。

## 默认搜索来源

`web_search` 优先尝试 Exa 的匿名托管接口，然后依次尝试 Keenable 的公开匿名接口、Bing、DuckDuckGo。配置了 Tavily Key 时，它作为最后的增强来源参与降级。

匿名接口不需要用户账号或密钥，但第三方服务存在额度、速率、网络和可用性限制。免费接口达到限制后，Nova 会继续尝试其他来源；所有来源都失败时会明确返回错误。Nova 不自动注册账户、购买额度、读取其他应用凭据或借用浏览器登录。

搜索只发送搜索词和搜索参数。默认搜索不额外调用当前会话模型生成摘要，返回来源、链接及短片段。Exa 与 Keenable 支持时间过滤；网页抓取降级来源不保证同等过滤精度。结果片段可能过时，具体事实应继续读取原始页面核对。

实现复用 Nova 的工具执行、权限、取消和展示链路，不需要用户配置 MCP，也不启动额外的 MCP 进程。

## 网页读取

`web_fetch` 默认返回网页正文。HTML 优先读取语义主内容，缺少该标记时使用文章提取；发布列表不会因为链接较多而被版权页脚替代。非 HTML 文本按原文读取。

JavaScript 执行后才出现的内容不保证能通过静态 HTTP 获得；工具会对识别出的空壳页面提示使用 Nova 浏览器工具。不会将敏感网页自动转发给远端抓取服务。

页面缓存最长保留两天。`force: true` 绕过页面和字段结果缓存；较早请求晚完成时，不能覆盖较新请求的页面缓存。取消、失败和超时不应使后续任务永久等待。

## 字段提取

显式使用 `mode: "extract"` 和 `fields` 时，工具只返回请求字段及核验结果，例如：

```js
await tools.web_fetch({
  url: 'https://example.com/pricing',
  mode: 'extract',
  fields: {
    monthly_price: 'number: Pro monthly price, excluding annual billing',
    currency: 'text: currency of that same monthly price'
  }
})
```

字段状态为：

- `extracted`：类型及置信度符合要求。文本和数值还需匹配唯一的页面原文证据。
- `uncertain`：有候选值，但类型、证据、唯一性或置信度不足；候选只放在 `guess`。
- `null`：提取模型没有找到该字段。页面被截断时，不能据此断言整个页面都没有该字段。

中文数值与跨行文本可以定位证据；重复内容以及 `1,299` 这类具有不同数量级读法的文本会保守降级。证据行号对应提取后的正文，跨行证据使用起始行号。

默认使用当前会话模型。完整配置 Cloudflare 凭据时使用 Clairic；配置不完整或请求失败不会静默更换提取模型。只有 extract 模式才会把正文发送给提取模型；默认正文读取没有这次模型调用。

**匿名搜索与静态网页读取没有模型提取费用；extract 会使用所选模型，可能产生相应费用。** 模型自报置信度不等于实测准确率。数字出现在页面中，也不自动证明它属于正确套餐、币种或计费周期。

## 脚本编排

默认 direct 模式可以直接调用搜索与网页工具。内部实验模式 `NOVA_TOOL_PRESENTATION=code-readonly` 可通过 `run_code` 连续搜索、读取、筛选和比较；结构化结果保留数字类型，网页中间结果留在沙箱，只有脚本日志和返回值进入主对话。

纯文件脚本保留 30 秒执行期限。只有实际调用了 Web 工具，本次脚本的总期限才延长至 120 秒；重复调用不会不断续期。共享 Worker 排队和执行期间均可取消。

若后处理改写使结构化结果不可用，脚本收到明确的 `ToolCallError`，不会成功返回与 SDK 声明不同的数据形状。

## 验证

日常单测不访问互联网。公开网络冒烟检查需要显式运行：

```powershell
node node_modules/vite-node/vite-node.mjs --script scripts/harness_eval/web_access_live.ts --live
```

真实 Electron 联网检查在构建后运行，模型边界使用本地 fake，搜索与页面请求走真实公开网络：

```powershell
npm run build
$env:NOVA_WEB_LIVE = '1'
try {
  npm --prefix tests/e2e exec -- playwright test --config tests/e2e/playwright.config.ts web-live/search.spec.ts
} finally {
  Remove-Item Env:NOVA_WEB_LIVE
}
```

这些检查证明指定样本的链路可用，不证明所有网站都可抓取、匿名额度无限，或真实模型字段提取始终正确。

## 参考

- [pi-web-access](https://github.com/nicobailon/pi-web-access/tree/d95fb1eb4350b90bd4285cbc84958085d136aa43)：搜索适配、字段协议与结构化编排的参考；保留 Nova 自身架构，许可见仓库 `THIRD_PARTY_NOTICES.md`。
- [Exa 官方 MCP 服务](https://github.com/exa-labs/exa-mcp-server)：支持有速率限制的匿名访问。
- [Keenable](https://keenable.ai/)：独立搜索服务；Nova 只调用公开匿名端点，不自动启用付费 API。
