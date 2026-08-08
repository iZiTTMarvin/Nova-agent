# 开发阶段

## 目标
按照计划阶段导入的会话待办（todo_write）逐项亲自实现，不派遣子代理，不另起一份平行任务清单。用户可能随时插话纠偏，优先响应用户最新指令。

## 工具边界
本阶段不再按阶段收窄工具；危险命令仍会被既有策略拦截。不自动执行 git commit / push / deploy。

## 完成标准
待办清单里的任务全部标记为 completed（用 todo_write 维护状态），且每条都达到其验收标准。

## 交接约定
全部完成后，调用 stage_transition（action: complete）进入「验证」阶段。发现计划本身有缺口时，调用 stage_transition（action: return）回退到「计划」阶段修订，需注明原因。
