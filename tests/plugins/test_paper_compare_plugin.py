"""Exercise real discovery, scoped config, sidecar HTTP, streaming and persistence."""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN = Path(__file__).resolve().parents[2] / "plugins/paper-compare"


def load_api():
    name = "paper_compare_api_test"
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "dashboard/plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def configure(home, base_url="http://127.0.0.1:3000/v1", key="test-paper-key"):
    home.mkdir(parents=True, exist_ok=True)
    (home / "plugins").mkdir(exist_ok=True)
    (home / "plugins/paper-compare").symlink_to(PLUGIN, target_is_directory=True)
    (home / ".env").write_text("LLM_API_KEY=obsolete-key-must-not-be-used\n", encoding="utf-8")
    config = {"model": {"provider": "latticecode", "default": "k3"}, "plugins": {"enabled": ["paper-compare"], "entries": {"paper-compare": {"settings": {
        "node_path": shutil.which("node"), "base_url": "http://untrusted.invalid/v1", "pdf_parser": "poppler",
    }}}}}
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    save_login(home, base_url, key)


def save_login(home, base_url, key):
    from hermes_cli.auth import _save_auth_store
    state = {"auth_method": "password", "logged_in": True, "username": home.name,
             "api_key": key, "inference_base_url": base_url, "token_refreshed_at": time.time()}
    _save_auth_store({"active_provider": "latticecode", "providers": {"latticecode": state} if key else {}}, target_path=home / "auth.json")


def test_native_discovery_is_inert_and_uses_public_sdk(tmp_path, monkeypatch):
    from hermes_cli.plugins import PluginManager
    from hermes_cli.plugin_validate import validate_plugin_dir

    home = tmp_path / "forx"
    configure(home)
    monkeypatch.setenv("FORX_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    manager = PluginManager(scope_key=str(home))
    manager.discover_and_load()
    plugin = next(row for row in manager.list_plugins() if row["name"] == "paper-compare")
    assert plugin["enabled"] and not plugin["error"]
    assert not plugin["tools"] and not plugin["hooks"]
    assert not (home / "plugin-data/paper-compare/library/library.sqlite").exists()
    assert validate_plugin_dir(PLUGIN).ok
    assert any(command["plugin"] == "paper-compare" for command in manager._cli_commands.values())


def test_profiles_stream_followups_and_restart_keep_their_own_state(tmp_path, monkeypatch):
    calls = []
    tenant_headers = []
    slow_done = threading.Event()

    class Gateway(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": "k3"}, {"id": "glm-5.3"}]}).encode())

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.headers.get("Authorization"), payload))
            tenant_headers.append(self.headers.get("X-Research-Tenant"))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            answer = payload["model"] + " private answer [P1.1]"
            if payload["model"] == "slow":
                self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": answer}, "finish_reason": None}]}) + "\n\n").encode())
                self.wfile.flush(); slow_done.wait(10); return
            for chunk in (
                {"choices": [{"delta": {"content": answer}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"total_tokens": 20}},
            ):
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode()); self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *_args):
            pass

    gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    worker = threading.Thread(target=gateway.serve_forever, daemon=True)
    worker.start()
    home = tmp_path / "forx"
    a, b = home, home / "profiles/reader-b"
    base = f"http://127.0.0.1:{gateway.server_port}/v1"
    configure(a, base, "test-paper-key-A")
    configure(b, base, "test-paper-key-B")
    monkeypatch.setenv("FORX_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    from agent import secret_scope
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    module = load_api()
    app = FastAPI(); app.include_router(module.router, prefix="/api/plugins/paper-compare")
    try:
        with TestClient(app) as client, httpx.Client(timeout=15) as web:
            path = "/api/plugins/paper-compare/launch"
            assert client.post(path, json={"frameOrigin": "https://untrusted.example"}).status_code == 503
            first = client.post(path, json={"frameOrigin": "null"}).json()
            url_a = first["url"]
            assert client.post(path, json={"frameOrigin": "null"}).json()["url"] == url_a
            url_b = client.post(path + "?profile=reader-b", json={"frameOrigin": "null"}).json()["url"]
            assert url_a != url_b
            assert web.get(url_a.split("/workbench/")[0] + "/api/config").status_code == 404
            html = web.get(url_a)
            assert "frame-ancestors file:" in html.headers["content-security-policy"]
            assert 'name="paper-storage-scope"' in html.text
            assert html.text.split('name="paper-storage-scope" content="')[1].split('"')[0] != web.get(url_b).text.split('name="paper-storage-scope" content="')[1].split('"')[0]
            assert web.get(url_a + "vendor/katex/katex.min.css").status_code == 200
            assert web.get(url_a + "app.js").status_code == 200
            config_a = web.get(url_a + "api/config").json()
            config_b = web.get(url_b + "api/config").json()
            assert config_a["keyConfigured"] and "test-paper-key" not in json.dumps(config_a)
            assert config_a["managedConnection"] and config_a["connection"]["managedBy"] == "forx"
            assert config_a["baseUrl"] == base
            ha, hb = ({"X-CSRF-Token": c["csrfToken"]} for c in (config_a, config_b))
            assert web.post(url_a + "api/config", headers=ha, json={"apiKey": "browser-key", "baseUrl": base}).status_code == 403
            assert web.post(url_a + "api/demo").status_code == 403
            uploaded_a = web.post(url_a + "api/documents", headers={**ha, "X-File-Name": "A.txt", "Content-Type": "application/octet-stream"}, content=("唯一论文 A\n\n公式与图表原文，用来验证模型独立记忆和证据隔离。" * 3).encode())
            assert uploaded_a.status_code == 201, uploaded_a.text
            doc_a = uploaded_a.json()
            assert not web.get(url_b + "api/library").json()["documents"]
            uploaded_b = web.post(url_b + "api/documents", headers={**hb, "X-File-Name": "B.txt", "Content-Type": "application/octet-stream"}, content=("另一篇论文 B，内容不会进入其他配置档案的问答与模型记忆。" * 3).encode())
            assert uploaded_b.status_code == 201, uploaded_b.text
            doc_b = uploaded_b.json()

            def ask(url, headers, doc, models, parent=None):
                body = {"documentId": doc["id"], "models": models, "question": "回忆自己的上轮回答", "analyze": False, "options": {"visualMode": "off"}}
                if parent:
                    body.update({"conversationId": parent["conversationId"], "parentTurnId": parent["id"]})
                response = web.post(url + "api/runs", headers=headers, json=body)
                assert response.status_code == 202, response.text
                task = response.json()
                with web.stream("GET", url + "api/runs/" + task["id"] + "/events") as stream:
                    events = "".join(stream.iter_text())
                assert "event:" in events
                turn = web.get(url + "api/turns/" + task["turnId"]).json()
                assert all(item["status"] == "done" for item in turn["answers"])
                return turn

            original = ask(url_a, ha, doc_a, ["k3", "glm-5.3"])
            ask(url_b, hb, doc_b, ["k3"])
            followup = ask(url_a, ha, doc_a, ["k3", "glm-5.3"], original)
            scoped = [(auth, payload) for auth, payload in calls if auth == "Bearer test-paper-key-A"]
            assert any(auth == "Bearer test-paper-key-B" for auth, _ in calls)
            for _, payload in scoped[-2:]:
                history = [m["content"] for m in payload["messages"] if m["role"] == "assistant"]
                assert history and all(text.startswith(payload["model"] + " private answer") for text in history)
            assert web.get(url_b + "api/turns/" + original["id"]).status_code == 404
            # Existing ForX auth.json is authoritative even while this sidecar stays up.
            save_login(a, base, "test-paper-key-A-rotated")
            rotated = ask(url_a, ha, doc_a, ["k3"], followup)
            assert calls[-1][0] == "Bearer test-paper-key-A-rotated"
            save_login(a, base, "")
            logged_out = web.get(url_a + "api/config").json()
            assert not logged_out["keyConfigured"] and logged_out["connection"]["state"] == "login_required"
            before = len(calls)
            conversations_before = web.get(url_a + 'api/conversations').json()
            denied = web.post(url_a + "api/runs", headers=ha, json={"documentId": doc_a["id"], "models": ["k3"], "question": "退出登录后不能调用", "analyze": False})
            assert denied.status_code == 400 and len(calls) == before
            assert web.get(url_a + 'api/conversations').json() == conversations_before
            assert web.get(url_a + "api/turns/" + rotated["id"]).status_code == 200
            assert web.get(url_b + "api/config").json()["keyConfigured"]
            # Endpoint changes follow ForX too; paper-local overrides never win.
            save_login(a, base.replace('/v1', '/updated/v1'), "test-paper-key-A-relogin")
            assert web.get(url_a + "api/config").json()["baseUrl"] == base.replace('/v1', '/updated/v1')
            ask(url_a, ha, doc_a, ["k3"], rotated)
            assert calls[-1][0] == "Bearer test-paper-key-A-relogin"
            slow = web.post(url_a + 'api/runs', headers=ha, json={"documentId": doc_a['id'], "models": ['slow'], "question": '保留这个生成中的草稿', "analyze": False, "options": {"visualMode": 'off'}}).json()
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                draft = web.get(url_a + 'api/turns/' + slow['turnId']).json()
                if draft['answers'][0]['text']:
                    break
                time.sleep(0.02)
            assert draft['answers'][0]['text']
            module.service.shutdown()
            restored = client.post(path, json={"frameOrigin": "null"}).json()["url"]
            assert restored != url_a
            assert urlparse(restored).netloc == urlparse(url_a).netloc
            assert web.get(restored).text.split('name="paper-storage-scope" content="')[1].split('"')[0] == html.text.split('name="paper-storage-scope" content="')[1].split('"')[0]
            assert web.get(restored + "api/turns/" + followup["id"]).json()["answers"] == followup["answers"]
            recovered = web.get(restored + 'api/turns/' + slow['turnId']).json()
            assert recovered['status'] == 'interrupted'
            assert recovered['answers'][0]['text'] == draft['answers'][0]['text']
            assert len(web.get(restored + "api/library").json()["documents"]) == 1
            # The same canonical resolver also serves ForX's custom API providers.
            cfg = yaml.safe_load((a / 'config.yaml').read_text())
            cfg['model'] = {'provider': 'custom:research', 'default': 'k3'}
            cfg['custom_providers'] = [{'name': 'research', 'base_url': base, 'key_env': 'RESEARCH_API_KEY',
                                        'extra_headers': {'X-Research-Tenant': 'tenant-A'}}]
            (a / '.env').write_text('RESEARCH_API_KEY=test-custom-forx-key\nLLM_API_KEY=obsolete-key\n')
            (a / 'config.yaml').write_text(yaml.safe_dump(cfg))
            custom = web.get(restored + 'api/config').json()
            assert custom['keyConfigured'] and custom['connection']['state'] == 'connected'
            assert 'test-custom-forx-key' not in json.dumps(custom)
            ask(restored, {'X-CSRF-Token': custom['csrfToken']}, doc_a, ['k3'], followup)
            assert calls[-1][0] == 'Bearer test-custom-forx-key' and tenant_headers[-1] == 'tenant-A'
    finally:
        slow_done.set()
        module.service.shutdown()
        gateway.shutdown(); gateway.server_close(); worker.join(timeout=5)
