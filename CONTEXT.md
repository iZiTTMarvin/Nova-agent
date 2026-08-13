# Nova Agent

桌面端 Coding Agent 应用：用户与模型对话，Agent 循环调用工具完成工程任务。本文件是项目统一语言（术语表）。

## Language

**Reasoning Effort（思考强度）**:
模型一次请求中投入推理深度的程度。项目统一枚举为 auto / low / medium / high / max，其中 auto 表示不向 provider 发送思考参数。
_Avoid_: thinking level, 推理等级

**Model Default Effort（模型默认思考强度）**:
在设置面板中按模型配置的默认思考强度，随模型注册表持久化，对所有会话生效。
_Avoid_: 模型思考配置

**Session Effort Override（会话思考强度覆盖）**:
用户在 composer 中为当前会话临时指定的思考强度；在该会话内优先于模型默认思考强度，不写回模型注册表。只作用于主会话的主对话，不影响上下文压缩、后台任务与子代理。
_Avoid_: 会话 effort, per-chat effort

**Cache Routing Key（缓存路由 key）**:
支持会话亲和的 provider 用于提示词缓存路由的会话级稳定标识，随会话懒生成并持久化，同一会话（含子代理会话各自独立）全程共用。仅主对话与子代理轮次请求消费；上下文压缩等一次性内部调用不携带，避免产生永不复用的缓存写入、挤占主对话的路由亲和。
_Avoid_: session cache key, 缓存会话 id
