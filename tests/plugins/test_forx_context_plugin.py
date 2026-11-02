"""Tests for forx-context plugin: analyzer, REST API, CLI, and tool registration."""
from __future__ import annotations

import importlib.util
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_state import SessionDB

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / "plugins/forx-context"
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

import analyzer
import cli

PREFIX = "/api/plugins/forx-context"


def _seed_test_session(db: SessionDB, session_id: str, model: str = "hermes") -> str:
    """Seed a test session with system prompt and several turns for verification."""
    system_prompt = (
        "You are an AI assistant.\n"
        "<skills>\n"
        "- git: Version control\n"
        "- web: Search web\n"
        "</skills>\n"
        "<tools>\n"
        "- read_file\n"
        "- write_file\n"
        "</tools>\n"
    )

    db.create_session(
        session_id=session_id,
        source="cli",
        model=model,
        system_prompt=system_prompt,
    )
    db.set_session_title(session_id, f"测试会话 Context 全景 {session_id}")

    # Insert turns: user, assistant, tool call, tool result
    db.append_message(session_id, "user", "请帮我分析代码并读取文件")
    db.append_message(
        session_id,
        "assistant",
        "好的，我来调用 read_file 工具。",
        tool_calls=[{
            "id": "call_1",
            "type": "function",
            "function": {"name": "read_file", "arguments": json.dumps({"path": "test.txt"})},
        }],
    )
    db.append_message(
        session_id,
        "tool",
        "file content: hello world",
        tool_call_id="call_1",
        tool_name="read_file",
    )
    db.append_message(session_id, "assistant", "文件内容读取完毕：hello world。")

    # Update token counts on session
    db.update_token_counts(
        session_id,
        input_tokens=1500,
        output_tokens=300,
        cache_read_tokens=400,
        estimated_cost_usd=0.0025,
    )
    return session_id


@pytest.fixture
def context_module():
    name = "forx_context_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_ROOT / "__init__.py", submodule_search_locations=[str(PLUGIN_ROOT)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def api_client():
    name = "forx_context_api_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard/plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)

    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    return TestClient(app)


def test_analyzer_session_breakdown(tmp_path, monkeypatch):
    """Verify context breakdown, capacity percentage, and tool statistics."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB()
    sid = "sess_ctx_001"
    _seed_test_session(db, sid, model="hermes")
    db.close()

    res = analyzer.analyze_session_context(sid)
    assert res["ok"] is True
    session_data = res["session"]
    assert session_data["id"] == sid
    assert session_data["title"] == f"测试会话 Context 全景 {sid}"

    # Capacity assertions
    cap = res["capacity"]
    assert cap["active_tokens"] > 0
    assert cap["context_limit"] > 0
    assert 0.0 <= cap["usage_pct"] <= 100.0
    assert cap["health_status"] in ("safe", "caution", "critical")

    # Token counters assertions
    tok = res["tokens"]
    assert tok["input_tokens"] == 1500
    assert tok["output_tokens"] == 300
    assert tok["cache_read_tokens"] == 400
    assert tok["cache_hit_rate"] > 0

    # Breakdown segments
    breakdown = res["breakdown"]
    segments = breakdown["segments"]
    assert len(segments) > 0
    seg_keys = [s["key"] for s in segments]
    assert "identity" in seg_keys
    assert "skills" in seg_keys
    assert "tools_schema" in seg_keys
    assert "user" in seg_keys
    assert "assistant" in seg_keys

    # Tool stats
    tools = res["tools"]
    tool_names = [t["name"] for t in tools]
    assert "read_file" in tool_names

    # Timeline steps
    timeline = res["timeline"]
    assert len(timeline) >= 4
    assert timeline[0]["role"] == "user"


def test_analyzer_fleet_overview(tmp_path, monkeypatch):
    """Verify fleet overview aggregates, trends and heatmap."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB()
    _seed_test_session(db, "sess_fleet_01", model="hermes")
    _seed_test_session(db, "sess_fleet_02", model="hermes")
    db.close()

    res = analyzer.get_fleet_context_overview(days=7)
    assert res["ok"] is True
    summary = res["summary"]
    assert summary["total_sessions"] >= 2
    assert summary["total_tokens"] > 0
    assert len(res["trend"]) == 7
    assert len(res["heatmap"]) == 56
    assert len(res["sessions"]) >= 2


def test_rest_api_endpoints(tmp_path, monkeypatch, api_client):
    """Verify REST API GET /overview, GET /sessions/{id}, and GET /current."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB()
    sid = "sess_api_001"
    _seed_test_session(db, sid, model="hermes")
    db.close()

    # 1. Overview
    resp = api_client.get(f"{PREFIX}/overview?days=7")
    assert resp.status_code == 200
    overview_data = resp.json()
    assert overview_data["ok"] is True
    assert overview_data["summary"]["total_sessions"] >= 1

    # 2. Session detail
    resp = api_client.get(f"{PREFIX}/sessions/{sid}")
    assert resp.status_code == 200
    detail = resp.json()
    assert detail["ok"] is True
    assert detail["session"]["id"] == sid
    assert detail["capacity"]["health_status"] in ("safe", "caution", "critical")

    # 3. Current session
    resp = api_client.get(f"{PREFIX}/current")
    assert resp.status_code == 200
    current_data = resp.json()
    assert current_data["ok"] is True


def test_tool_and_slash_handlers(tmp_path, monkeypatch, context_module):
    """Verify model tool context_inspect and slash command /context."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB()
    sid = "sess_tool_001"
    _seed_test_session(db, sid, model="hermes")
    db.close()

    # Tool handler concise
    concise_raw = context_module._tool_handler({"session_id": sid, "detailed": False})
    concise_data = json.loads(concise_raw)
    assert concise_data["session_id"] == sid
    assert "usage_percentage" in concise_data
    assert "health_status" in concise_data

    # Tool handler detailed
    detailed_raw = context_module._tool_handler({"session_id": sid, "detailed": True})
    detailed_data = json.loads(detailed_raw)
    assert detailed_data["ok"] is True
    assert "breakdown" in detailed_data
    assert "timeline" in detailed_data

    # Slash command handler
    terminal_out = context_module._slash_handler(sid)
    assert "Context 全景洞察" in terminal_out
    assert sid in terminal_out
    assert "容量占比" in terminal_out


def test_cli_presentation(tmp_path, monkeypatch):
    """Verify terminal formatting helper in cli.py."""
    assert cli._format_token_k(500) == "500"
    assert cli._format_token_k(1500) == "1.5k"
    assert cli._format_token_k(2_500_000) == "2.50M"

    bar = cli._render_ascii_bar(50.0, width=10)
    assert len(bar) == 10
    assert "█" in bar and "░" in bar

    # Test error formatting
    err_out = cli.format_session_terminal({"ok": False, "error": "Not found"})
    assert "错误" in err_out


def test_plugin_registration(context_module):
    """Verify plugin register(ctx) invokes expected registrar methods."""
    class FakeContext:
        def __init__(self):
            self.commands = {}
            self.cli_commands = {}
            self.tools = {}
            self.skills = {}

        def register_cli_command(self, name, help, setup_fn, handler_fn):
            self.cli_commands[name] = {"help": help, "setup": setup_fn, "handler": handler_fn}

        def register_command(self, name, handler, description="", args_hint=""):
            self.commands[name] = {"handler": handler, "desc": description, "hint": args_hint}

        def register_tool(self, name, toolset, schema, handler, description="", **kwargs):
            self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

        def register_skill(self, name, skill_path, description=""):
            self.skills[name] = {"path": skill_path, "desc": description}

    ctx = FakeContext()
    context_module.register(ctx)

    assert "context" in ctx.cli_commands
    assert "context" in ctx.commands
    assert "context_inspect" in ctx.tools
    assert "context-inspect" in ctx.skills
