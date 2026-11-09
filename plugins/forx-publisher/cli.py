"""CLI subcommands and terminal presentation for forx-publisher.

Wired into the main Hermes CLI via ctx.register_cli_command(name="publish", ...).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Optional

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

try:
    from .publisher import (
        DEFAULT_TARGET_REPO,
        check_target,
        get_auth_status,
        publish_plugin,
        publish_skill,
    )
except ImportError:
    from publisher import (
        DEFAULT_TARGET_REPO,
        check_target,
        get_auth_status,
        publish_plugin,
        publish_skill,
    )

console = Console()


def setup(subparser: argparse.ArgumentParser) -> None:
    """Register 'hermes publish' subcommands and CLI flags."""
    subparser.description = "发布本地自研的插件或技能到全平台公共库，供所有用户安装使用。"
    subs = subparser.add_subparsers(dest="publish_action", help="发布操作子命令")

    # 1. check
    p_check = subs.add_parser("check", help="检查本地插件或技能的合规性与安全状态")
    p_check.add_argument("path", help="待检查的插件或技能本地目录路径")
    p_check.add_argument(
        "--type",
        choices=["auto", "plugin", "skill"],
        default="auto",
        help="目标类型（默认 auto 自动识别）",
    )

    # 2. plugin
    p_plugin = subs.add_parser("plugin", help="验证并将本地插件发布到 Plugin Catalog")
    p_plugin.add_argument("path", help="插件目录路径（需包含 plugin.yaml）")
    p_plugin.add_argument(
        "--target-repo",
        default=DEFAULT_TARGET_REPO,
        help=f"提交PR的目标仓库 (默认: {DEFAULT_TARGET_REPO})",
    )
    p_plugin.add_argument("--git-url", default="", help="插件的公开 GitHub 仓库地址 (若本地为 git 仓库可自动提取)")
    p_plugin.add_argument("--sha", default="", help="锁定的 40 位 Git Commit SHA (若本地为 git 仓库可自动提取)")
    p_plugin.add_argument("--category", default="tools", help="分类目录 (desktop/memory/tools/web/automation 等)")
    p_plugin.add_argument("--maintainer", default="", help="维护者名称或 GitHub 用户名")
    p_plugin.add_argument("--dry-run", action="store_true", help="仅验证并生成目录条目，不向 GitHub 发起真实 PR")

    # 3. skill
    p_skill = subs.add_parser("skill", help="安全扫描并将本地技能发布到公共 Skills 库")
    p_skill.add_argument("path", help="技能目录路径（需包含 SKILL.md）")
    p_skill.add_argument(
        "--target-repo",
        default=DEFAULT_TARGET_REPO,
        help=f"提交PR的目标仓库 (默认: {DEFAULT_TARGET_REPO})",
    )
    p_skill.add_argument("--name", default="", help="技能标识名 (默认读取 frontmatter 中的 name)")
    p_skill.add_argument(
        "--dest-dir",
        default="optional-skills",
        help="在目标仓库中的存放子目录 (默认: optional-skills)",
    )
    p_skill.add_argument("--dry-run", action="store_true", help="仅运行安全扫描与模拟上传，不发起真实 PR")

    # 4. auth
    subs.add_parser("auth", help="检查 GitHub 认证状态及 Token 配置")


def run(args: argparse.Namespace) -> int:
    """Entry point when user runs 'hermes publish <action> ...'."""
    action = getattr(args, "publish_action", None)
    if not action:
        console.print("[yellow]请指定发布子命令：check, plugin, skill, auth[/]")
        console.print("示例: [bold]hermes publish check ./my-tool[/]")
        console.print("      [bold]hermes publish plugin ./my-plugin[/]")
        console.print("      [bold]hermes publish skill ./my-skill[/]")
        return 1

    if action == "auth":
        return _run_auth()
    elif action == "check":
        return _run_check(args.path, getattr(args, "type", "auto"))
    elif action == "plugin":
        return _run_plugin(args)
    elif action == "skill":
        return _run_skill(args)
    else:
        console.print(f"[red]未知子命令: {action}[/]")
        return 1


def _run_auth() -> int:
    console.print(Panel("[bold cyan]GitHub 认证状态检查[/]", expand=False))
    status = get_auth_status()
    if status["authenticated"]:
        console.print(f"✅ [green]已认证[/] (方式: [bold]{status['method']}[/], 用户名: [bold]{status.get('username') or '未知'}[/])")
        console.print("[dim]你已具备自动 Fork 并向公共库创建 Pull Request 的权限。[/]")
        return 0
    else:
        console.print(f"❌ [red]未检测到有效的 GitHub 认证凭据[/]")
        console.print(f"\n{status.get('error') or ''}\n")
        console.print("[bold yellow]快速配置指南：[/]")
        console.print("1. 方式一（推荐）：在终端运行 [bold]gh auth login[/] 并按提示在浏览器登录。")
        console.print("2. 方式二：生成具有 `repo` 权限的 Personal Access Token (PAT)，并写入配置：")
        console.print("   在 ~/.hermes/.env 中添加: [bold]GITHUB_TOKEN=ghp_xxxxxx[/]\n")
        return 1


def _run_check(path: str, target_type: str) -> int:
    console.print(f"[bold]正在检查:[/] {path} (类型: {target_type})...")
    res = check_target(path, target_type=target_type)

    if not res.get("ok"):
        console.print(f"❌ [bold red]检查未通过:[/] {res.get('error') or '未知错误'}")
        if res.get("validation", {}).get("failures"):
            console.print("\n[bold red]失败项:[/]")
            for f in res["validation"]["failures"]:
                console.print(f"  • {f}")
        return 1

    detected = res.get("target_type")
    if detected == "plugin":
        console.print(f"✅ [bold green]插件合规检查全部通过！[/] 插件名: [cyan]{res['name']}[/] (v{res['version']})")
        git_info = res.get("git", {})
        if git_info.get("is_git_repo"):
            console.print(f"   Git Remote: [blue]{git_info.get('remote_url') or '未设置'}[/]")
            console.print(f"   Commit SHA: [dim]{git_info.get('commit_sha') or '未解析'}[/]")
            if git_info.get("is_dirty"):
                console.print("   ⚠️ [yellow]检测到本地工作区有未提交代码，发布前请先 git commit & push！[/]")
        else:
            console.print("   ⚠️ [yellow]当前目录不是 Git 仓库。发布插件需先托管至 GitHub 公开仓库。[/]")

        console.print("\n[bold cyan]生成的 Catalog YAML 预览：[/]")
        console.print(Panel(res.get("catalog_yaml_preview", ""), title="plugin-catalog YAML", expand=False))

    elif detected == "skill":
        verdict = res.get("verdict", "safe")
        color = "green" if verdict in ("safe", "clean") else "yellow"
        console.print(f"✅ [bold green]技能规范检查通过！[/] 技能名: [cyan]{res['name']}[/]")
        console.print(f"   安全扫描结果: [{color} bold]{verdict.upper()}[/]")
        console.print(f"   描述: [dim]{res.get('description')}[/]")
        if res.get("findings"):
            console.print(f"   发现 {len(res['findings'])} 个关注点 (非致命):")
            for fd in res["findings"]:
                console.print(f"     - [{fd.get('severity', 'info')}] {fd.get('description')}")

    console.print("\n[green]一切准备就绪，可使用 'hermes publish plugin/skill' 提交发布！[/]")
    return 0


def _run_plugin(args: argparse.Namespace) -> int:
    path = args.path
    dry_run = args.dry_run
    mode_text = "[dry-run 预演]" if dry_run else "[正式提交]"
    console.print(f"[bold]开始发布插件 {mode_text}:[/] {path} -> {args.target_repo}")

    res = publish_plugin(
        path=path,
        repo_url=args.git_url,
        commit_sha=args.sha,
        target_repo=args.target_repo,
        category=args.category,
        maintainer=args.maintainer,
        dry_run=dry_run,
    )

    if not res.get("ok"):
        console.print(f"\n❌ [bold red]发布失败:[/] {res.get('error')}")
        return 1

    if dry_run:
        console.print(f"\n✅ [bold green]预演检查通过！[/]")
        console.print(f"目标目录: [cyan]{res['catalog_entry_path']}[/]")
        console.print(Panel(res.get("catalog_yaml", ""), title="生成的 Catalog YAML", expand=False))
        console.print("[dim]添加 --dry-run 参数时不会发起真实 PR。去掉该参数即可正式发布。[/]")
        return 0

    console.print(f"\n🎉 [bold green]PR 创建成功！[/]")
    console.print(f"PR 链接: [bold cyan]{res['pr_url']}[/]")
    console.print(f"目标条目: [dim]{res['catalog_entry_path']}[/]")
    console.print(
        "\n[bold yellow]后续流程说明：[/]\n"
        "1. 官方 CI 将自动对你的提交运行规范验证（validate_plugin_catalog）。\n"
        "2. 维护者审核并合并 PR 后，文档与全网索引将自动重新编译。\n"
        f"3. 随后全平台所有用户均可通过 [bold]forx plugins install {res['name']}[/] 直接安装使用！"
    )
    return 0


def _run_skill(args: argparse.Namespace) -> int:
    path = args.path
    dry_run = args.dry_run
    mode_text = "[dry-run 预演]" if dry_run else "[正式提交]"
    console.print(f"[bold]开始发布技能 {mode_text}:[/] {path} -> {args.target_repo}")

    res = publish_skill(
        path=path,
        target_repo=args.target_repo,
        skill_name=args.name,
        dest_dir=args.dest_dir,
        dry_run=dry_run,
    )

    if not res.get("ok"):
        console.print(f"\n❌ [bold red]发布失败:[/] {res.get('error')}")
        return 1

    if dry_run:
        console.print(f"\n✅ [bold green]预演检查通过！[/]")
        console.print(f"技能名称: [cyan]{res['name']}[/]")
        console.print(f"目标路径: [dim]{res['destination_path']}[/]")
        console.print(f"待上传文件清单 ({len(res.get('files_to_upload', []))} 个文件):")
        for f in res.get("files_to_upload", []):
            console.print(f"  • {f}")
        return 0

    console.print(f"\n🎉 [bold green]技能 PR 创建成功！[/]")
    console.print(f"PR 链接: [bold cyan]{res['pr_url']}[/]")
    console.print(
        "\n[bold yellow]后续流程说明：[/]\n"
        "1. 维护者审核并合并 PR 后，统一索引脚本（build_skills_index）将自动将该技能收录进 skills-index.json。\n"
        f"2. 随后全平台所有用户均可通过 [bold]forx skills install {res['name']}[/] 一键安装使用！"
    )
    return 0
