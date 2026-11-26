# 更新日志 / Changelog

All notable changes to ForX will be documented in this file.

---

## [v0.1.21] - 2026-11-26

### 🚀 新增功能与体验优化 / Features & Enhancements
- **ForX 品牌视觉焕新 (Visual Identity Refresh)**：
  - 全面更新桌面端、引导安装器、Web 控制台、TUI 终端及文档站点的 ForX 图标、横幅与主题配色。
- **插件与技能发布器升级 (`forx-publisher`)**：
  - 新增对话式交互发布引导工作流（升级 `forx-publish` 技能并内置到核心技能目录，增强 `/publish` 斜杠命令自动发现候选项目）。
  - 桌面端发布器界面升级，支持毛玻璃质感主题、分段式步骤条、IDE 风格 YAML 预览与对话引导入口。
- **桌面端面板布局与视觉精修 (Desktop Shell & Pane Frames)**：
  - 为停靠面板与窄抽屉引入圆角外框（`PaneFrame`）与统一间距（`--pane-gap`）拖拽分隔条，优化嵌套分栏缩放与终端悬浮裁剪对齐。
  - 统一壳层控件尺寸、稳定标签页悬停表现、优化侧边栏毛玻璃过渡，并按当前界面语言本地化工具调用与命令摘要。

### 🐛 问题修复 / Bug Fixes
- **插件目录与工具恢复 (Catalog & Plugin Tools)**：
  - 统一桌面端内嵌浏览面板与文档站的插件/技能目录体验，恢复插件目录自动同步工作流（`catalog-sync.yml`）。
  - 恢复 `forx-context` 与 `forx-publisher` 插件工具及内置技能注册，修复桌面端预览文件读取与插件目录半同步问题。
  - 新增/更新插件目录条目：`forx-latex`（`v0.2.0`）与 `paper-compare`（适配最新 ForX SDK）。

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
