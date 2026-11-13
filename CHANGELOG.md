# 更新日志 / Changelog

All notable changes to ForX will be documented in this file.

---

## [v0.1.20] - 2026-11-13

### 🚀 新增功能 / Features
- **插件目录同步与更新推送 (Catalog Sync)**：
  - 新增上游插件 Git HEAD 自动巡检工具 (`scripts/sync_plugin_catalog.py`) 与 GitHub Actions 定时同步工作流 (`.github/workflows/catalog-sync.yml`)。
  - 增强 `forx-publisher` 发布器插件，支持为已存在的插件/技能发起“更新条目”PR（`Update plugin: <name>`）。
  - 支持在应用中直接配置、验证与保存 GitHub Personal Access Token。
- **本地已安装插件批量升级 (Batch Plugin Update)**：
  - 客户端支持目录缓存强制刷新（`force=True`），即时获取最新 catalog 提交与版本。
  - CLI `forx plugins update [--all]` 支持批量检测与升级所有已安装的老版本插件，并在插件列表中清晰标注可用更新。
- **桌面端插件一键卸载 (Desktop Plugin Uninstall)**：
  - 桌面端插件管理页（Capabilities -> Plugins）新增删除/卸载按钮（`Trash2` 图标）。
  - 危险操作二次确认弹窗（`confirm` 对话框），防止误删。
  - 卸载时彻底清理插件文件夹、配置记录及桌面端扩展，内置核心插件受保护不可随意卸载。
- **自动化发布与更新日志 (Automated Release Notes)**：
  - 发布流程自动提取版本更新介绍并集成到 GitHub Release 页面。

---

## [v0.1.19] - 2026-10-10

### 🚀 功能与修复 / Features & Fixes
- 优化桌面端与网关进程间 RPC 通信及生命周期管理。
- 增强内嵌 Python 3.11 环境打包稳定性与跨平台安装体验。
- 优化插件热重载与工具集动态绑定机制。
