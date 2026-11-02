---
name: context-inspect
description: Inspect and monitor LLM context window utilization, token distribution, cost, compression events, and tool execution footprint.
---

# Context Inspect (上下文全景洞察)

当用户询问当前会话的 Token 消耗、上下文容量、剩余可用窗口、模型压缩情况，或想要优化提示词与工具负载时使用。

## 核心能力
1. **上下文容量体检**：评估当前活跃 Token 与模型上下文窗口上限（Context Length）的比例，诊断当前处于 Safe（<65%）、Caution（65%~85%）还是 Critical（>85%）状态。
2. **上下文构成拆解**：清晰区分系统设定（System Prompt）、技能库（Skills）、工具契约（Tools Schema）、历史记忆（Memory）、用户消息、模型回复思考（Reasoning）以及工具返回数据所占用的比例。
3. **压缩与归档追踪**：检测是否发生了上下文压缩（Compaction），已归档释放了多少 Token。
4. **Token 与成本核算**：实时统计 Prompt / Completion / Cache Read 命中率及估算花费。

## 使用方式
你可以直接调用内置工具 `context_inspect`：
- `context_inspect()`：查看当前会话的上下文健康度和主要指标。
- `context_inspect(detailed=True)`：获取完整的构成分布和工具调用统计。
- 在终端或聊天中，用户亦可使用命令 `forx context` 或 `/context` 获得可视化报告。
