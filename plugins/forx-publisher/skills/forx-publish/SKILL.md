---
name: forx-publish
description: 协助用户在客户端将本地自研的插件或技能进行合规体检、安全扫描，并自动向社区公共仓库发起Pull Request进行发布，供全平台用户使用。当用户说"发布我的插件"、"提交插件到商店"、"分享技能"、"publish plugin"、"publish skill"时调用。
---

# ForX 社区发布助手 (ForX Community Publisher)

本技能帮助用户将本地自研的**插件（Plugin）**或**技能（Skill）**提交并发布到公共库，使全平台所有用户都能通过 `forx plugins install` 或 `forx skills install` 进行搜索与安装。

## 发布流程原则

1. **先检查，后发布**：
   在正式向远程仓库发起 PR 之前，必须先调用 `forx_publish_check` 工具对目标目录进行体检：
   - **插件**：检查 `plugin.yaml` 格式、依赖规范、能力声明一致性、无任意代码注入、Git 仓库状态与 40 位 SHA。
   - **技能**：检查 `SKILL.md` frontmatter、运行 `skills_guard` 安全扫描，确保无 `DANGEROUS` 恶意行为。

2. **确认认证凭据**：
   发布需要 GitHub 授权。向用户说明需要满足以下任一条件：
   - 方式 A：已在本地终端执行过 `gh auth login`；
   - 方式 B：在 `~/.hermes/.env` 中配置了 `GITHUB_TOKEN=ghp_xxxx`（需具备 `repo` 或 `public_repo` 权限）。

3. **预演与确认（Dry-Run）**：
   在调用 `forx_publish_plugin` 或 `forx_publish_skill` 时，可先传入 `dry_run=true` 展示将要创建的目录条目与提交信息，向用户清晰展示并获得确认后再执行真实提交。

## 执行步骤

### 场景 A：发布插件（Plugin）

1. **定位插件目录**：
   询问或确认插件的本地路径（如 `~/.hermes/plugins/my-plugin` 或指定项目路径）。
2. **执行体检**：
   ```json
   {
     "name": "forx_publish_check",
     "arguments": {
       "path": "<插件路径>",
       "target_type": "plugin"
     }
   }
   ```
3. **处理检查反馈**：
   - 若出现失败项（如未声明 tools、缺少 description 等），指导用户在 `plugin.yaml` 中补充。
   - 检查 Git 状态：若本地代码未提交或未关联远程仓库，提醒用户先执行 `git commit` 和 `git push`。
4. **发起发布 PR**：
   调用 `forx_publish_plugin`：
   ```json
   {
     "name": "forx_publish_plugin",
     "arguments": {
       "path": "<插件路径>",
       "category": "tools",
       "dry_run": false
     }
   }
   ```
5. **告知用户后续生效流程**：
   - PR 创建成功后，提供 PR 链接。
   - 说明：官方 CI 会执行自动验证，维护者合并 PR 后，全局 `/api/plugin-catalog.json` 会自动更新，全平台所有用户即可直接运行 `forx plugins install <插件名>`！

### 场景 B：发布技能（Skill）

1. **定位技能目录**：
   确认包含 `SKILL.md` 的技能目录路径。
2. **执行安全扫描**：
   ```json
   {
     "name": "forx_publish_check",
     "arguments": {
       "path": "<技能路径>",
       "target_type": "skill"
     }
   }
   ```
3. **发起发布 PR**：
   调用 `forx_publish_skill`：
   ```json
   {
     "name": "forx_publish_skill",
     "arguments": {
       "path": "<技能路径>",
       "dry_run": false
     }
   }
   ```
4. **告知后续生效流程**：
   - 官方合并 PR 后，统一索引脚本会将技能纳入 `skills-index.json`。
   - 全网用户即可直接运行 `forx skills install <技能名>` 使用。
