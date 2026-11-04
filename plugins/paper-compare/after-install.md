# 论文工作台

1. 在 Capabilities → Plugins 启用论文工作台的 Agent 与 Desktop 两部分。
2. 重新启动 ForX 后端，然后从侧栏打开“论文工作台”。首次打开会校验 Node.js 22.13+ 并准备锁定的生产依赖。
3. 模型账号与接口沿用 ForX 的“账号与模型”；MinerU 地址在论文插件设置中配置。

论文和阅读记录保存在当前配置档案的 `plugin-data/paper-compare/library`。升级插件会继续使用原库，无需重新上传、重新解析或导入历史。运行环境可通过 `forx paper doctor` 检查。

本插件用于本机桌面与本机 Dashboard；远程、SSH、云端连接需要先切换回本机。
