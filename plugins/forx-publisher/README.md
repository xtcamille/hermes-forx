# ForX 社区发布中心 (forx-publisher)

`forx-publisher` 是一个内置于客户端的插件与技能发布套件。它支持用户在本地客户端对自研的 **插件 (Plugins)** 与 **技能 (Skills)** 进行一站式合规检查、安全审计，并自动向社区公共仓库提交 Pull Request，合入后即可让全平台所有用户搜索与安装使用。

---

## 核心特性

1. **双生态支持**：
   - **插件 (Plugin)**：自动进行 `plugin.yaml` 规范验证、依赖检查、能力真实性审计、Git 仓库状态与 40 位 SHA 锁定，自动生成标准的 `plugin-catalog/*.yaml` 清单。
   - **技能 (Skill)**：自动校验 `SKILL.md` frontmatter，运行官方 `skills_guard` 安全扫描，拦截恶意代码。
2. **多端交互体验**：
   - **CLI 命令行**：`hermes publish check` / `hermes publish plugin` / `hermes publish skill`
   - **会话 Slash 指令**：`/publish check <path>` / `/publish plugin <path>` / `/publish skill <path>`
   - **桌面图形界面 (Desktop UI)**：内置原生桌面端工作台，在左侧导航栏点击「发布与共享」、输入路由 `/publish` 或通过 `⌘K` 唤起，支持三步可视化向导式操作（目标配置 ➔ 合规体检 ➔ 一键提 PR）。
   - **大模型自主调用 (Tools)**：`forx_publish_check`, `forx_publish_plugin`, `forx_publish_skill`
   - **引导技能 (Skill)**：内置 `forx-publish` 技能，通过对话式交互由 AI 助手一步步协助用户检查和发布。
   - **图形端 API (Dashboard / Desktop)**：提供完整的 FastAPI 路由接口，供图形界面直观操作。
3. **零额外核心入侵**：
   - 严格遵守 Hermes 插件规范，全部能力通过 `register(ctx)` 无缝注入，不修改任何核心文件。

---

## 准备工作：配置 GitHub 认证

发布过程会自动向公共仓库发起 Pull Request，因此需要 GitHub 授权凭据：

- **方式一（推荐）**：在终端使用 GitHub CLI 登录：
  ```bash
  gh auth login
  ```
- **方式二**：在 `~/.hermes/.env` 中添加你的 Personal Access Token（需要具备 `repo` 或 `public_repo` 权限）：
  ```env
  GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
  ```

验证认证状态：
```bash
hermes publish auth
```

---

## 使用指南

### 1. 检查规范与安全性 (`check`)

在正式提交前，先对本地目录进行体检：
```bash
# 自动识别插件或技能
hermes publish check ./my-custom-plugin

# 明确指定类型
hermes publish check ./my-skill --type skill
```

### 2. 发布插件 (`plugin`)

```bash
# 预演模式（Dry-run）：只验证并预览生成的 catalog 条目，不创建真实 PR
hermes publish plugin ./my-plugin --dry-run

# 正式发布（自动 Fork -> 创建分支 -> 上传 catalog 描述 -> 创建 PR）
hermes publish plugin ./my-plugin
```

> **注意**：发布的插件需要先推送到公开的 GitHub 仓库。如果本地是 Git 仓库，工具会自动提取 remote URL 和当前 HEAD 的 Commit SHA；也可以手动传入：
> ```bash
> hermes publish plugin ./my-plugin --git-url https://github.com/user/my-plugin --sha <40位SHA>
> ```

### 3. 发布技能 (`skill`)

```bash
# 预演模式
hermes publish skill ./my-skill --dry-run

# 正式发布
hermes publish skill ./my-skill
```

---

## 生效机制

1. **自动化 CI 与审核**：PR 创建后，官方仓库 CI 会自动触发静态与运行时沙箱验证；
2. **全局即时生效**：PR 被维护者合并后，系统自动化流程会刷新全局 `plugin-catalog.json` / `skills-index.json`；
3. **终端用户安装**：
   - 插件：所有用户即可通过 `forx plugins install <插件名>` 安装。
   - 技能：所有用户即可通过 `forx skills install <技能名>` 安装。
