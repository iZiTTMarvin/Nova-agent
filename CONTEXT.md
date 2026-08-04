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
