"""CLI and Terminal presentation for forx-context."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, Optional

try:
    from .analyzer import analyze_session_context, get_fleet_context_overview
except ImportError:
    from analyzer import analyze_session_context, get_fleet_context_overview


def _format_token_k(tok: int) -> str:
    if tok >= 1_000_000:
        return f"{tok / 1_000_000:.2f}M"
    elif tok >= 1_000:
        return f"{tok / 1_000:.1f}k"
    return str(tok)


def _render_ascii_bar(pct: float, width: int = 24) -> str:
    filled = int(round((max(0.0, min(100.0, pct)) / 100.0) * width))
    empty = width - filled
    return "█" * filled + "░" * empty


def format_session_terminal(data: Dict[str, Any]) -> str:
    if not data.get("ok"):
        return f"❌ 错误: {data.get('error', '未知错误')}"

    s = data["session"]
    cap = data["capacity"]
    tok = data["tokens"]
    cost = data["cost"]
    bd = data["breakdown"]
    tools = data.get("tools", [])

    status_icon = "🟢 安全 (Safe)" if cap["health_status"] == "safe" else (
        "🟡 警告 (Caution)" if cap["health_status"] == "caution" else "🔴 临界 (Critical)"
    )

    bar = _render_ascii_bar(cap["usage_pct"], width=28)

    lines = [
        "════════════════════════════════════════════════════════════════",
        f"  📊 ForX Context 全景洞察 (Context Insights)",
        "════════════════════════════════════════════════════════════════",
        f"  会话 ID:   {s['id']}",
        f"  会话标题: {s['title']}",
        f"  使用模型: {s['model']}",
        f"  健康状态: {status_icon}",
        "────────────────────────────────────────────────────────────────",
        f"  容量占比: [{bar}] {cap['usage_pct']}%",
        f"  活跃 Token: {_format_token_k(cap['active_tokens'])} / {_format_token_k(cap['context_limit'])} "
        f"(剩余可用: {_format_token_k(cap['remaining_tokens'])})",
    ]

    if cap.get("compacted_tokens", 0) > 0:
        lines.append(f"  压缩归档: {_format_token_k(cap['compacted_tokens'])} tokens (已释放)")

    lines.extend([
        "────────────────────────────────────────────────────────────────",
        "  💰 Token 与成本统计:",
        f"    • Prompt 输入:       {_format_token_k(tok['input_tokens'])} tokens",
        f"    • Completion 输出:   {_format_token_k(tok['output_tokens'])} tokens",
        f"    • Cache 读取命中:    {_format_token_k(tok['cache_read_tokens'])} tokens ({tok['cache_hit_rate']}%)",
        f"    • 预估成本:          ${cost['cost_usd']:.4f} USD  (约 ¥{cost['cost_cny']:.2f} CNY)",
        "────────────────────────────────────────────────────────────────",
        "  🧩 上下文组成分布 (Context Breakdown):",
    ])

    for seg in bd.get("segments", []):
        t_k = _format_token_k(seg["tokens"])
        pct_of_active = (seg["tokens"] / max(1, cap["active_tokens"])) * 100
        lines.append(f"    • {seg['label']:<34}: {t_k:>8} ({pct_of_active:4.1f}%)")

    if tools:
        lines.extend([
            "────────────────────────────────────────────────────────────────",
            "  🛠️ 工具调用频次 (Tool Executions):",
        ])
        for t in tools[:8]:
            err_str = f" [! {t['errors']} 错误]" if t["errors"] > 0 else ""
            lines.append(f"    • {t['name']:<24}: {t['calls']:>3} 次  (~{_format_token_k(t['tokens'])} toks){err_str}")

    lines.append("════════════════════════════════════════════════════════════════")
    return "\n".join(lines)


def setup(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("session_id", nargs="?", default=None, help="会话 ID (省略则自动选择最近活跃会话)")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出完整上下文剖析数据")
    parser.add_argument("--profile", default=None, help="目标配置 profile 名称")
    parser.add_argument("--fleet", action="store_true", help="显示全局会话上下文与 Token 汇总")


def run(args: argparse.Namespace) -> None:
    if getattr(args, "fleet", False):
        data = get_fleet_context_overview(profile=getattr(args, "profile", None))
        if getattr(args, "json", False):
            print(json.dumps(data, ensure_ascii=False, indent=2))
            return
        summary = data.get("summary", {})
        print("════════════════════════════════════════════════════════════════")
        print("  🌐 ForX 全局会话上下文统计 (Fleet Overview)")
        print("════════════════════════════════════════════════════════════════")
        print(f"  总会话数:     {summary.get('total_sessions', 0)}")
        print(f"  累计 Token:   {_format_token_k(summary.get('total_tokens', 0))}")
        print(f"  Prompt 输入:  {_format_token_k(summary.get('input_tokens', 0))}")
        print(f"  Output 输出:  {_format_token_k(summary.get('output_tokens', 0))}")
        print(f"  Cache 读取:   {_format_token_k(summary.get('cache_read_tokens', 0))} (命中率: {summary.get('cache_hit_rate', 0)}%)")
        print(f"  累计花费:     ${summary.get('total_cost_usd', 0):.4f} USD (约 ¥{summary.get('total_cost_cny', 0):.2f} CNY)")
        print("════════════════════════════════════════════════════════════════")
        return

    sid = getattr(args, "session_id", None)
    profile = getattr(args, "profile", None)

    if not sid:
        # Fallback to most recent session
        overview = get_fleet_context_overview(profile=profile)
        sessions = overview.get("sessions", [])
        if not sessions:
            print("未找到任何会话。")
            return
        sid = sessions[0]["id"]

    data = analyze_session_context(sid, profile=profile)
    if getattr(args, "json", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(format_session_terminal(data))
