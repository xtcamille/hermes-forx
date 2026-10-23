"""Real plugin discovery, file roundtrips and A→B→A profile-scoped edit contracts."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import shutil
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest

Presentation = pytest.importorskip("pptx", reason="Install forx-ppt's optional Python dependencies to run native PPTX integration tests").Presentation


PLUGIN = Path(__file__).resolve().parents[2] / "plugins/forx-ppt"
PREFIX = "/api/plugins/forx-ppt"


def configure(home):
    target = home / "plugins/forx-ppt"
    shutil.copytree(PLUGIN, target, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
    (home / "config.yaml").write_text("plugins:\n  enabled: [forx-ppt]\n", encoding="utf-8")
    return target


def load_api(root):
    name = "forx_ppt_api_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, root / "dashboard/plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix=PREFIX)
    return module, app


def check(response, expected=200):
    assert response.status_code == expected, response.text
    return response.json()


def create(client, **kwargs):
    return check(client.post(PREFIX + "/projects", json={"name": "产品方案", "slides": [
        {"title": "产品介绍", "bullets": ["面向客户介绍产品。"], "layout_id": "L001"},
        {"title": "市场机会", "bullets": ["保留该页独立内容。"]},
    ], "request_id": uuid.uuid4().hex, **kwargs}))


def edit(client, current, operations, *, request_id=None, status=200, suffix=""):
    return check(client.post(f'{PREFIX}/projects/{current["deck"]["id"]}/edit{suffix}', json={
        "revision": current["revision"], "operations": operations, "request_id": request_id or uuid.uuid4().hex,
    }), status)


def test_discovery_native_objects_inheritance_identity_and_roundtrip(tmp_path, monkeypatch, capsys):
    from hermes_cli.plugins import PluginManager
    from hermes_cli.plugin_validate import validate_plugin_dir

    home = tmp_path / "forx"
    root = configure(home)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("FORX_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    manager = PluginManager(scope_key=str(home))
    manager.discover_and_load()
    loaded = next(p for p in manager.list_plugins() if p["name"] == "forx-ppt")
    assert loaded["enabled"] and not loaded["error"], loaded
    assert not loaded["tools"]  # CLI+skill adds no permanent model tool schema.
    assert "ppt" in manager._cli_commands
    assert any(entry["plugin_key"] == "forx-ppt" for entry in manager._plugin_skills.values())
    assert not (home / "plugin-data/forx-ppt/projects.db").exists()
    report = validate_plugin_dir(root)
    assert report.ok, report
    api, app = load_api(root)
    with TestClient(app) as client:
        original = create(client)
        assert not original["issues"]  # A one-line footer must fit the actual native text margins.
        deck = original["deck"]
        sid, tid = deck["slides"][1]["id"], deck["slides"][1]["elements"][0]["id"]
        brand = deck["master"]["elements"][0]["id"]
        pixels = io.BytesIO()
        Image.new("RGB", (48, 24), "navy").save(pixels, format="PNG")
        asset = check(client.post(PREFIX + "/assets", json={"data": base64.b64encode(pixels.getvalue()).decode()}))["asset_id"]
        current = edit(client, original, [
            {"action": "update_element", "target": tid, "slide_id": sid, "changes": {"text": "增长机会", "style": {"color": "#C0392B"}}},
            {"action": "master_style", "target": "title", "changes": {"font_size": 36}},
            {"action": "update_element", "target": brand, "changes": {"text": "ACME"}},
            {"action": "add_element", "target": "M001", "element": {"kind": "image", "name": "母版 Logo", "asset_id": asset, "box": {"x": 9.5, "y": .2, "width": 1, "height": .5}}},
            {"action": "add_element", "slide_id": sid, "element": {"kind": "image", "name": "产品图片", "asset_id": asset, "box": {"x": 8, "y": 2, "width": 4, "height": 2}}},
            {"action": "add_element", "slide_id": sid, "element": {"kind": "table", "name": "数据表", "box": {"x": .6, "y": 4, "width": 4, "height": 1.5}, "rows": [["分类", "数值"], ["示例", "20"]]}},
            {"action": "add_element", "slide_id": sid, "element": {"kind": "chart", "name": "趋势图", "box": {"x": 5, "y": 4, "width": 5, "height": 2}, "categories": ["A", "B"], "series": [{"name": "示例", "values": [10, 20]}]}},
            {"action": "move_slide", "target": sid, "index": 0},
            {"action": "theme", "changes": {"preset": "technology"}},
        ])
        image_id = next(e["id"] for e in current["deck"]["slides"][0]["elements"] if e["kind"] == "image")
        table_id = next(e["id"] for e in current["deck"]["slides"][0]["elements"] if e["kind"] == "table")
        current = edit(client, current, [{"action": "group", "slide_id": sid, "ids": [image_id, table_id]}])
        group = next(e for e in current["deck"]["slides"][0]["elements"] if e["kind"] == "group")
        smaller = {**group["box"], "width": group["box"]["width"] * .8, "height": group["box"]["height"] * .8}
        current = edit(client, current, [{"action": "update_element", "target": group["id"], "changes": {"box": smaller}}])
        current = edit(client, current, [{"action": "ungroup", "target": group["id"]}])
        assert {image_id, table_id} <= {e["id"] for e in current["deck"]["slides"][0]["elements"]}
        current = edit(client, current, [
            {"action": "update_element", "target": table_id, "changes": {"column_widths": [2, 1]}},
            *[{"action": "add_element", "slide_id": sid, "element": {"kind": "chart", "name": kind + "图", "chart_type": kind,
               "box": {"x": .6, "y": 2, "width": 4, "height": 2}, "categories": ["A", "B"], "series": [{"name": "示例", "values": [10, 20]}]}}
              for kind in ("line", "pie")],
        ])
        pid = deck["id"]
        view = check(client.get(f'{PREFIX}/projects/{pid}/preview/{sid}?revision={current["revision"]}&numbers=true'))
        title = next(e for e in view["elements"] if e["id"] == tid)
        assert title["style"]["font_size"] == 36 and title["style"]["color"] == "#C0392B"
        assert brand in view["svg"] and "ACME" in view["svg"] and tid in view["svg"]
        assert current["deck"]["slides"][0]["id"] == sid
        assert current["deck"]["slides"][1] == original["deck"]["slides"][0]
        file = check(client.get(f'{PREFIX}/projects/{pid}/download?revision={current["revision"]}'))
        blob = base64.b64decode(file["data"])
        prs = Presentation(io.BytesIO(blob))
        native = prs.slides[0]
        assert native.shapes.title.text == "增长机会"
        native_title = native.shapes.title
        assert native_title.name.startswith(tid + "_") and native_title.is_placeholder
        assert native_title.text_frame.paragraphs[0].runs[0].font.size is None  # master font remains inherited.
        assert any(s.name.startswith(brand + "_") and s.text == "ACME" for s in prs.slide_master.shapes if s.has_text_frame)
        assert any(s.shape_type == 13 for s in prs.slide_master.shapes)
        assert any(s.has_table and s.table.cell(1, 1).text == "20" for s in native.shapes)
        table = next(s.table for s in native.shapes if s.has_table)
        assert table.columns[0].width == pytest.approx(table.columns[1].width * 2, abs=2)
        model_charts = [e for e in current["deck"]["slides"][0]["elements"] if e["kind"] == "chart"]
        for source in model_charts:
            exported = next(s.chart for s in native.shapes if s.name.startswith(source["id"] + "_"))
            assert list(exported.series[0].values) == source["series"][0]["values"]
        chart = next(s.chart for s in native.shapes if s.has_chart)
        assert list(chart.series[0].values) == [10, 20]
        assert chart.part.chart_workbook.xlsx_part.blob.startswith(b"PK")
        assert any(s.shape_type == 13 for s in native.shapes)  # native picture, not a slide screenshot.
        assert len(prs.slide_layouts) == len(current["deck"]["layouts"])
        imported = check(client.post(PREFIX + "/import", json={"format": "pptx", "data": file["data"], "request_id": uuid.uuid4().hex}))
        assert imported["deck"]["id"] != pid
        assert imported["deck"]["slides"] == current["deck"]["slides"]
        assert imported["deck"]["master"] == current["deck"]["master"]
        import argparse
        command = manager._cli_commands["ppt"]
        parser = argparse.ArgumentParser()
        command["setup_fn"](parser)
        capsys.readouterr()
        assert command["handler_fn"](parser.parse_args(["show", "--project", pid])) == 0
        assert json.loads(capsys.readouterr().out)["deck"]["slides"] == current["deck"]["slides"]
        # Editing an exported native object outside ForX must not be silently discarded by metadata import.
        native.shapes.title.text = "外部修改"
        changed = io.BytesIO(); prs.save(changed)
        check(client.post(PREFIX + "/import", json={"format": "pptx", "data": base64.b64encode(changed.getvalue()).decode(), "request_id": uuid.uuid4().hex}), 422)
    manager.unload()


def test_scoped_chat_atomic_retries_history_cancel_and_profile_isolation(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home

    home = tmp_path / "forx"
    other = home / "profiles/ppt-b"
    root = configure(home)
    configure(other)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("FORX_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    api, app = load_api(root)
    calls = []

    class HostModel:
        async def acomplete_structured(self, **kwargs):
            from types import SimpleNamespace
            calls.append((str(get_hermes_home()), kwargs))
            if kwargs.get("schema_name") == "forx_ppt_draft":
                return SimpleNamespace(parsed={
                    "name": "区块链技术介绍",
                    "theme": "technology",
                    "slides": [
                        {"title": "区块链概述", "bullets": ["去中心化账本", "智能合约"], "layout_id": "L001"},
                        {"title": "核心架构", "bullets": ["共识算法", "加密哈希"], "layout_id": "L003"},
                    ],
                    "message": "初稿已生成。",
                })
            context = json.loads(kwargs["input"][0]["text"])
            target = context["selected_ids"][0]
            return SimpleNamespace(parsed={"message": "已更新指定标题。", "operations": [{"action": "update_element", "target": target, "changes": {"text": "精准更新"}}]})

    # Only the external model response is substituted; routing, scope, planning validation,
    # SQLite edits, imports and exported files all use the production implementation.
    monkeypatch.setattr(api.planner, "llm_client", HostModel)
    with TestClient(app) as client:
        a = create(client)
        pid = a["deck"]["id"]
        tid = a["deck"]["slides"][0]["elements"][0]["id"]
        assert check(client.get(PREFIX + "/projects?profile=ppt-b"))["projects"] == []
        check(client.get(f"{PREFIX}/projects/{pid}?profile=ppt-b"), 404)
        b = check(client.post(PREFIX + "/projects?profile=ppt-b", json={"name": "B 的文稿", "request_id": "b-create"}))
        assert check(client.get(PREFIX + "/projects"))["projects"][0]["id"] == pid
        # Activating B put the process in multiplex mode; A→B→A still resolves each owning home.
        assert (home / "plugin-data/forx-ppt/projects.db").exists() and (other / "plugin-data/forx-ppt/projects.db").exists()
        body = {"prompt": "只改选中标题", "project_id": pid, "revision": a["revision"], "selection": [tid], "request_id": "chat-a"}
        changed = check(client.post(PREFIX + "/chat", json=body))["result"]
        assert changed["deck"]["slides"][0]["elements"][0]["text"] == "精准更新"
        assert changed["deck"]["slides"][1] == a["deck"]["slides"][1]
        assert Path(calls[-1][0]) == home
        replay = check(client.post(PREFIX + "/chat", json=body))["result"]
        assert replay["revision"] == changed["revision"] and len(calls) == 1
        edit(client, a, [{"action": "update_element", "target": tid, "changes": {"text": "过期修改"}}], status=409)
        edit(client, changed, [
            {"action": "update_element", "target": tid, "changes": {"text": "不应部分生效"}},
            {"action": "update_element", "target": "E9999", "changes": {"text": "目标不存在"}},
        ], status=422)
        assert check(client.get(f"{PREFIX}/projects/{pid}")) == changed
        check(client.post(PREFIX + "/cancel", json={"request_id": "cancel-edit"}))
        edit(client, changed, [{"action": "theme", "changes": {"preset": "minimal"}}], request_id="cancel-edit", status=409)
        # Initial draft creation via chat without project_id
        draft_chat = check(client.post(PREFIX + "/chat", json={"prompt": "生成区块链介绍", "request_id": "chat-draft"}))["result"]
        assert draft_chat["deck"]["name"] == "区块链技术介绍"
        assert len(draft_chat["deck"]["slides"]) == 2
        assert draft_chat["deck"]["theme"]["name"] == "深色科技"
        add_key = "add-retry"
        add = [{"action": "add_slide", "slide": {"title": "新增页", "bullets": [], "elements": [{"id": "E0006"}]}}]
        newer = edit(client, changed, add, request_id=add_key)
        assert edit(client, changed, add, request_id=add_key)["revision"] == newer["revision"]
        new_ids = {e["id"] for e in newer["deck"]["slides"][-1]["elements"]}
        undo = check(client.post(f"{PREFIX}/projects/{pid}/undo", json={"revision": newer["revision"], "request_id": "undo"}))
        assert undo["deck"]["slides"] == changed["deck"]["slides"]
        redo = check(client.post(f"{PREFIX}/projects/{pid}/redo", json={"revision": undo["revision"], "request_id": "redo"}))
        assert redo["deck"]["slides"] == newer["deck"]["slides"]
        restored = check(client.post(f"{PREFIX}/restore/{pid}", json={"revision": redo["revision"], "version": 1, "request_id": "restore"}))
        assert restored["deck"]["slides"] == a["deck"]["slides"]
        branch = edit(client, restored, add)
        assert not (new_ids & {e["id"] for e in branch["deck"]["slides"][-1]["elements"]})
        with_preassigned_id = [{"action": "add_element", "slide_id": branch["deck"]["slides"][0]["id"], "element": {"id": "E9999", "name": "自动重配ID", "kind": "text", "text": "内容", "box": {"x": 1, "y": 1, "width": 4, "height": 1}}}]
        with_id_res = edit(client, branch, with_preassigned_id)
        added_elem = [e for e in with_id_res["deck"]["slides"][0]["elements"] if e["name"] == "自动重配ID"][0]
        assert added_elem["id"] != "E9999" and added_elem["id"].startswith("E")
        assert check(client.get(f'{PREFIX}/projects/{b["deck"]["id"]}?profile=ppt-b')) == b
        assert check(client.get(f"{PREFIX}/projects/{pid}"))["revision"] == with_id_res["revision"]
        assert check(client.get(f"{PREFIX}/projects/{pid}/history"))["history"][0]["version"] == with_id_res["revision"]
