---
name: br-full-dev
description: 一句话跑完开发全流程（需求构思 → 计划拆分 → 执行验证 → 综合审查 → 汇报发布）
workflow: br-full-dev
user-invocable: true
disable-model-invocation: true
argument-hint: "<需求描述>"
---

# br-full-dev

用户可见的编排入口。输入 `/br-full-dev <需求>` 后：

1. 自动切换到**编排模式**（compose）
2. 启动内置编排脚本 `br-full-dev`
3. 脚本按阶段强制推进，发布前会询问是否提交

本技能正文不会注入对话；实际流程由编排运行时执行。
