# 验

## 做什么
派 inspector 子代理，只给它一页纸与工作区路径，不给实施过程。
核验者必须用 inspection_report 提交正式结论；不要另行规定报告末行的措辞。
拿到结论后一句话转述：几条通过、哪条没过、现象是什么。

## 做到什么算完
核验者已完成，并提交本阶段的正式通过结果与实际操作依据。

## 怎么交接
未通过：调用 stage_transition return build，并说明要修什么；最多两轮。
通过：调用 stage_transition complete。
已核验但缺少正式结果：按工具反馈，用 task_followup 让原 inspector 补交；不要由主代理写报告文件代替，也不要盲目重复推进阶段。
