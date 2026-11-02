# forx-context (Context 全景洞察)

`forx-context` 是专为 ForX (Hermes Agent) 打造的会话上下文深度透视、Token/成本核算与可视化监控原生插件。

## 功能亮点

1. **多维度上下文组成拆解 (Breakdown)**
   - 系统设定与身份 (System Prompt & Identity)
   - 技能库与指引 (Skills & Instructions)
   - 工具契约 (Tools Schema)
   - 长期记忆 (Memory Context)
   - 用户提示 (User Messages)
   - 助手回复与思考 (Assistant & Reasoning)
   - 工具执行产物 (Tool Calls & Outputs)
   - 压缩归档历史 (Compacted History)

2. **容量健康仪表盘 (Capacity Gauge)**
   - 活跃 Token vs 模型上下文上限 (Context Window Length)
   - 状态评级：🟢 安全 Safe (<65%) | 🟡 警戒 Caution (65%~85%) | 🔴 临界 Critical (>85%)
   - 压缩归档释放追踪

3. **Token 与成本实时统计**
   - Prompt 输入 / Completion 输出 / Cache 读取命中
   - 命中率百分比与预估费用 ($ USD / ¥ CNY)

4. **演化走势与时间线 (Timeline & Trends)**
   - 逐轮 Step 演变折线与事件
   - 过去 7 天 / 30 天消耗柱状图
   - 8 周活跃热力图 (GitHub-style Activity Heatmap)

5. **多端无缝体验**
   - **Desktop 全景大屏**：直接访问 `/context` 查看全局 KPI、图表与会话列表
   - **Desktop 协同抽屉**：对话时右侧边栏实时伴生显示当前会话 Context 容量
   - **状态栏指标**：底部状态栏实时显示当前上下文使用率（如 `⚡ 40%`）
   - **命令行 CLI**：`forx context [session_id] [--json]`
   - **斜杠命令**：`/context`
   - **Agent 工具**：`context_inspect(session_id, detailed)`

## 快速使用

### 终端命令
```bash
# 查看最近活跃会话的上下文全景
forx context

# 指定会话 ID
forx context <session_id>

# 查看全局汇总
forx context --fleet

# 导出原始 JSON 数据
forx context --json
```

### Agent 对话中
可以直接对 Agent 说：
- "帮我分析一下当前会话的上下文占用和 Token 消耗"
- "我现在的上下文窗口还剩多少容量？"
Agent 会自动调用 `context_inspect` 工具进行体检。
