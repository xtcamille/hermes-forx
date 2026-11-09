"""forx-publisher: In-client publishing & sharing center for plugins and skills."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from .cli import run, setup
    from .publisher import (
        DEFAULT_TARGET_REPO,
        check_target,
        get_auth_status,
        publish_plugin,
        publish_skill,
    )
except ImportError:
    from cli import run, setup
    from publisher import (
        DEFAULT_TARGET_REPO,
        check_target,
        get_auth_status,
        publish_plugin,
        publish_skill,
    )

CHECK_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "forx_publish_check",
        "description": "Inspect and validate a local plugin or skill before publishing to ensure it meets admission and safety standards.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path of the plugin or skill to inspect.",
                },
                "target_type": {
                    "type": "string",
                    "enum": ["auto", "plugin", "skill"],
                    "description": "Target type ('auto' detects automatically from directory contents).",
                },
            },
            "required": ["path"],
        },
    },
}

PUBLISH_PLUGIN_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "forx_publish_plugin",
        "description": "Submit a local plugin to the official Plugin Catalog via GitHub Pull Request for all users to install.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path of the plugin (must contain plugin.yaml).",
                },
                "repo_url": {
                    "type": "string",
                    "description": "Public HTTPS GitHub URL of the plugin repository. If omitted, resolved from local git remote.",
                },
                "commit_sha": {
                    "type": "string",
                    "description": "40-character hex commit SHA to pin. If omitted, resolved from local git HEAD.",
                },
                "category": {
                    "type": "string",
                    "description": "Catalog shelf category (desktop, memory, platform, web, tools, voice, automation, models, general). Default: tools.",
                },
                "maintainer": {
                    "type": "string",
                    "description": "Maintainer identifier or GitHub handle.",
                },
                "target_repo": {
                    "type": "string",
                    "description": f"Target repository to submit the PR against (default: {DEFAULT_TARGET_REPO}).",
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "If true, validates and previews generated catalog YAML without creating a real PR.",
                },
            },
            "required": ["path"],
        },
    },
}

PUBLISH_SKILL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "forx_publish_skill",
        "description": "Scan and submit a local skill to the community repository via GitHub Pull Request for all users to search and install.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path of the skill (must contain SKILL.md).",
                },
                "skill_name": {
                    "type": "string",
                    "description": "Optional name identifier for the skill (defaults to frontmatter name).",
                },
                "target_repo": {
                    "type": "string",
                    "description": f"Target repository to submit the PR against (default: {DEFAULT_TARGET_REPO}).",
                },
                "dest_dir": {
                    "type": "string",
                    "description": "Destination directory in repository (default: optional-skills).",
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "If true, scans and checks files without creating a real PR.",
                },
            },
            "required": ["path"],
        },
    },
}


def _tool_check_handler(args: Dict[str, Any]) -> str:
    path = args.get("path", "")
    target_type = args.get("target_type", "auto")
    res = check_target(path, target_type=target_type)
    return json.dumps(res, ensure_ascii=False, indent=2)


def _tool_publish_plugin_handler(args: Dict[str, Any]) -> str:
    res = publish_plugin(
        path=args.get("path", ""),
        repo_url=args.get("repo_url", ""),
        commit_sha=args.get("commit_sha", ""),
        target_repo=args.get("target_repo", DEFAULT_TARGET_REPO),
        category=args.get("category", "tools"),
        maintainer=args.get("maintainer", ""),
        dry_run=bool(args.get("dry_run", False)),
    )
    return json.dumps(res, ensure_ascii=False, indent=2)


def _tool_publish_skill_handler(args: Dict[str, Any]) -> str:
    res = publish_skill(
        path=args.get("path", ""),
        target_repo=args.get("target_repo", DEFAULT_TARGET_REPO),
        skill_name=args.get("skill_name", ""),
        dest_dir=args.get("dest_dir", "optional-skills"),
        dry_run=bool(args.get("dry_run", False)),
    )
    return json.dumps(res, ensure_ascii=False, indent=2)


def _slash_handler(raw_args: str) -> str:
    parts = (raw_args or "").strip().split()
    if not parts:
        auth = get_auth_status()
        auth_msg = f"已认证 ({auth.get('username')})" if auth["authenticated"] else "未认证 (需配置 GITHUB_TOKEN)"
        return (
            f"**ForX 社区发布中心**\n\n"
            f"- GitHub 状态: {auth_msg}\n\n"
            f"**常用命令:**\n"
            f"- `/publish check <路径>` — 检查插件或技能规范\n"
            f"- `/publish plugin <路径>` — 发布插件到 Catalog\n"
            f"- `/publish skill <路径>` — 发布技能到公共技能库\n"
            f"- `/publish auth` — 查看 GitHub 认证与授权状态\n"
        )

    sub = parts[0].lower()
    if sub == "auth":
        st = get_auth_status()
        if st["authenticated"]:
            return f"✅ GitHub 已认证，用户: `{st.get('username')}` (认证方式: `{st.get('method')}`)"
        return f"❌ 未认证: {st.get('error')}"

    if len(parts) < 2:
        return f"用法: `/publish {sub} <路径>`"

    target_path = parts[1]
    if sub == "check":
        res = check_target(target_path)
        if res.get("ok"):
            return f"✅ 检查通过！类型: `{res.get('target_type')}`, 名称: `{res.get('name')}`"
        return f"❌ 检查未通过: {res.get('error') or '详见终端日志'}"

    elif sub == "plugin":
        res = publish_plugin(target_path, dry_run=False)
        if res.get("ok"):
            return f"🎉 插件发布 PR 已发起！链接: {res.get('pr_url')}"
        return f"❌ 插件发布失败: {res.get('error')}"

    elif sub == "skill":
        res = publish_skill(target_path, dry_run=False)
        if res.get("ok"):
            return f"🎉 技能发布 PR 已发起！链接: {res.get('pr_url')}"
        return f"❌ 技能发布失败: {res.get('error')}"

    return f"未知子命令: `{sub}`。支持 `check`, `plugin`, `skill`, `auth`。"


def register(ctx: Any) -> None:
    # 1. CLI subcommand: hermes publish <action>
    ctx.register_cli_command(
        name="publish",
        help="Publish local plugins or skills to the community repository via automated PR",
        setup_fn=setup,
        handler_fn=run,
    )

    # 2. In-session Slash command: /publish
    ctx.register_command(
        name="publish",
        handler=_slash_handler,
        description="Check and publish local plugins or skills to the global community repository",
        args_hint="[check|plugin|skill|auth] <path>",
    )

    # 3. Model Tools
    ctx.register_tool(
        name="forx_publish_check",
        toolset="publisher",
        schema=CHECK_TOOL_SCHEMA,
        handler=_tool_check_handler,
        description="Inspect and validate a local plugin or skill for publication readiness.",
    )

    ctx.register_tool(
        name="forx_publish_plugin",
        toolset="publisher",
        schema=PUBLISH_PLUGIN_TOOL_SCHEMA,
        handler=_tool_publish_plugin_handler,
        description="Submit a verified plugin into the public Plugin Catalog via Pull Request.",
    )

    ctx.register_tool(
        name="forx_publish_skill",
        toolset="publisher",
        schema=PUBLISH_SKILL_TOOL_SCHEMA,
        handler=_tool_publish_skill_handler,
        description="Scan and submit a verified skill into the community repository via Pull Request.",
    )

    # 4. Skill
    skill_file = Path(__file__).parent / "skills" / "forx-publish" / "SKILL.md"
    if skill_file.exists():
        ctx.register_skill(
            name="forx-publish",
            skill_path=skill_file,
            description="Guide users to inspect, validate, package, and publish their plugins or skills to the public repository.",
        )
