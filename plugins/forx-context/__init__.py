"""forx-context: Context insight, capacity monitoring, and token analytics plugin."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from .analyzer import analyze_session_context, get_fleet_context_overview
    from .cli import format_session_terminal, run, setup
except ImportError:
    from analyzer import analyze_session_context, get_fleet_context_overview
    from cli import format_session_terminal, run, setup

TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "context_inspect",
        "description": "Inspect conversation context capacity, token breakdown, health status (safe/caution/critical), and compression statistics.",
        "parameters": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Optional session ID to inspect. If omitted, inspects current session.",
                },
                "detailed": {
                    "type": "boolean",
                    "description": "Whether to include full breakdown segments and tool execution lists.",
                },
            },
        },
    },
}


def _tool_handler(args: Dict[str, Any]) -> str:
    sid = args.get("session_id")
    detailed = bool(args.get("detailed", False))
    if not sid:
        # Pick the most recent session from fleet overview
        fleet = get_fleet_context_overview()
        sessions = fleet.get("sessions", [])
        if sessions:
            sid = sessions[0]["id"]
        else:
            return json.dumps({"error": "No active sessions found"})

    data = analyze_session_context(sid)
    if not data.get("ok"):
        return json.dumps(data, ensure_ascii=False)

    if not detailed:
        # Return concise capacity and health summary
        return json.dumps(
            {
                "session_id": data["session"]["id"],
                "model": data["session"]["model"],
                "active_tokens": data["capacity"]["active_tokens"],
                "context_limit": data["capacity"]["context_limit"],
                "usage_percentage": f"{data['capacity']['usage_pct']}%",
                "health_status": data["capacity"]["health_status"],
                "remaining_tokens": data["capacity"]["remaining_tokens"],
                "compacted_tokens": data["capacity"]["compacted_tokens"],
                "cost_usd": data["cost"]["cost_usd"],
                "cache_hit_rate": f"{data['tokens']['cache_hit_rate']}%",
            },
            ensure_ascii=False,
            indent=2,
        )

    return json.dumps(data, ensure_ascii=False, indent=2)


def _slash_handler(raw_args: str) -> str:
    sid = (raw_args or "").strip() or None
    if not sid:
        fleet = get_fleet_context_overview()
        sessions = fleet.get("sessions", [])
        if sessions:
            sid = sessions[0]["id"]
        else:
            return "未找到任何会话。"

    data = analyze_session_context(sid)
    return format_session_terminal(data)


def register(ctx: Any) -> None:
    # 1. CLI subcommand: hermes context [session_id]
    ctx.register_cli_command(
        name="context",
        help="Inspect session context capacity, token breakdown and timeline",
        setup_fn=setup,
        handler_fn=run,
    )

    # 2. In-session Slash command: /context
    ctx.register_command(
        name="context",
        handler=_slash_handler,
        description="Inspect session context window breakdown, tokens and health",
        args_hint="[session_id]",
    )

    # 3. Model Tool: context_inspect
    ctx.register_tool(
        name="context_inspect",
        toolset="context",
        schema=TOOL_SCHEMA,
        handler=_tool_handler,
        description="Inspect context window capacity, active tokens, and breakdown",
    )

    # 4. Skill
    skill_file = Path(__file__).parent / "skills" / "context-inspect" / "SKILL.md"
    if skill_file.exists():
        ctx.register_skill(
            name="context-inspect",
            skill_path=skill_file,
            description="Inspect context window token usage, compression points, and memory health.",
        )
