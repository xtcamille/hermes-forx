"""Tests for forx-publisher plugin: inspection, catalog generation, GitHub PR flows, CLI, API, and registration."""
from __future__ import annotations

import importlib.util
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / "plugins/forx-publisher"
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

import cli
import publisher

PREFIX = "/api/plugins/forx-publisher"


@pytest.fixture
def publisher_module():
    name = "forx_publisher_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(
        name, PLUGIN_ROOT / "__init__.py", submodule_search_locations=[str(PLUGIN_ROOT)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def api_client():
    name = "forx_publisher_api_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard/plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)

    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    return TestClient(app)


def test_normalize_github_url():
    assert publisher.normalize_github_url("git@github.com:foo/bar.git") == "https://github.com/foo/bar"
    assert publisher.normalize_github_url("https://github.com/foo/bar.git") == "https://github.com/foo/bar"
    assert publisher.normalize_github_url("https://github.com/foo/bar/") == "https://github.com/foo/bar"


def test_generate_catalog_yaml():
    name = "demo-plugin"
    repo = "https://github.com/testuser/demo-plugin"
    sha = "a" * 40
    desc = "A helpful demo plugin"
    maintainer = "testuser"

    yaml_str = publisher.generate_catalog_yaml(
        name=name,
        repo_url=repo,
        commit_sha=sha,
        description=desc,
        maintainer=maintainer,
        category="tools",
        version="1.0.0",
        capabilities={"provides_tools": ["tool_a"], "provides_hooks": []},
    )

    import yaml
    data = yaml.safe_load(yaml_str)
    assert data["name"] == name
    assert data["repo"] == repo
    assert data["sha"] == sha
    assert data["description"] == desc
    assert data["maintainer"] == maintainer
    assert data["tier"] == "community"
    assert data["capabilities"]["provides_tools"] == ["tool_a"]

    # Test invalid SHA raises ValueError
    with pytest.raises(ValueError, match="Invalid commit SHA"):
        publisher.generate_catalog_yaml(name, repo, "bad-sha", desc, maintainer)


def test_check_target_plugin(tmp_path):
    plugin_dir = tmp_path / "sample-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        "name: sample-plugin\n"
        "version: 0.2.0\n"
        "description: Test plugin description\n"
        "author: Tester\n"
        "capabilities:\n"
        "  provides_tools: [sample_tool]\n",
        encoding="utf-8",
    )
    (plugin_dir / "__init__.py").write_text(
        "def register(ctx):\n"
        "    ctx.register_tool('sample_tool', 'sample', {}, lambda a: 'ok')\n",
        encoding="utf-8",
    )

    res = publisher.check_target(plugin_dir, target_type="plugin")
    assert res["target_type"] == "plugin"
    assert res["name"] == "sample-plugin"
    assert res["version"] == "0.2.0"
    assert "catalog_preview" in res
    assert res["catalog_preview"]["name"] == "sample-plugin"


def test_check_target_skill(tmp_path):
    skill_dir = tmp_path / "sample-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: sample-skill\n"
        "description: A test skill for doing automated tasks\n"
        "---\n"
        "# Instructions\n"
        "Step 1: do this safely\n",
        encoding="utf-8",
    )

    res = publisher.check_target(skill_dir, target_type="skill")
    assert res["ok"] is True
    assert res["target_type"] == "skill"
    assert res["name"] == "sample-skill"
    assert res["verdict"] in ("safe", "clean", "caution")


def test_publish_skill_dry_run(tmp_path):
    skill_dir = tmp_path / "my-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: my-skill\n"
        "description: My awesome test skill\n"
        "---\n"
        "Instructions here",
        encoding="utf-8",
    )
    (skill_dir / "script.py").write_text("print('hello')", encoding="utf-8")

    res = publisher.publish_skill(skill_dir, dry_run=True)
    assert res["ok"] is True
    assert res["dry_run"] is True
    assert res["name"] == "my-skill"
    assert "SKILL.md" in res["files_to_upload"]
    assert "script.py" in res["files_to_upload"]


def test_publish_skill_mocked_github(tmp_path):
    skill_dir = tmp_path / "my-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: my-skill\n"
        "description: My awesome test skill\n"
        "---\n"
        "Instructions here",
        encoding="utf-8",
    )

    fake_auth = MagicMock()
    fake_auth.is_authenticated.return_value = True

    with patch("publisher.GitHubPRClient") as MockClientClass:
        mock_client = MockClientClass.return_value
        mock_client.get_authenticated_user.return_value = "alice"
        mock_client.fork_repository.return_value = "alice/hermes-forx"
        mock_client.get_default_branch_sha.return_value = ("main", "b" * 40)
        mock_client.open_pull_request.return_value = {
            "ok": True,
            "pr_url": "https://github.com/xtcamille/hermes-forx/pull/999",
            "pr_number": 999,
        }

        res = publisher.publish_skill(skill_dir, dry_run=False, auth=fake_auth)
        assert res["ok"] is True
        assert res["pr_url"] == "https://github.com/xtcamille/hermes-forx/pull/999"
        assert res["pr_number"] == 999
        mock_client.put_file.assert_called()


def test_publish_plugin_dry_run(tmp_path):
    plugin_dir = tmp_path / "my-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        "name: my-plugin\n"
        "version: 1.0.0\n"
        "description: Great plugin\n"
        "author: Alice\n",
        encoding="utf-8",
    )
    (plugin_dir / "__init__.py").write_text("def register(ctx): pass\n", encoding="utf-8")

    res = publisher.publish_plugin(
        path=plugin_dir,
        repo_url="https://github.com/alice/my-plugin",
        commit_sha="c" * 40,
        dry_run=True,
    )
    assert res["ok"] is True
    assert res["dry_run"] is True
    assert res["name"] == "my-plugin"
    assert "plugin-catalog/my-plugin.yaml" == res["catalog_entry_path"]
    assert "https://github.com/alice/my-plugin" in res["catalog_yaml"]


def test_publish_plugin_mocked_github(tmp_path):
    plugin_dir = tmp_path / "my-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        "name: my-plugin\n"
        "version: 1.0.0\n"
        "description: Great plugin\n"
        "author: Alice\n",
        encoding="utf-8",
    )
    (plugin_dir / "__init__.py").write_text("def register(ctx): pass\n", encoding="utf-8")

    fake_auth = MagicMock()
    fake_auth.is_authenticated.return_value = True

    with patch("publisher.GitHubPRClient") as MockClientClass:
        mock_client = MockClientClass.return_value
        mock_client.get_authenticated_user.return_value = "alice"
        mock_client.fork_repository.return_value = "alice/hermes-forx"
        mock_client.get_default_branch_sha.return_value = ("main", "b" * 40)
        mock_client.open_pull_request.return_value = {
            "ok": True,
            "pr_url": "https://github.com/xtcamille/hermes-forx/pull/1001",
            "pr_number": 1001,
        }

        res = publisher.publish_plugin(
            path=plugin_dir,
            repo_url="https://github.com/alice/my-plugin",
            commit_sha="c" * 40,
            dry_run=False,
            auth=fake_auth,
        )
        assert res["ok"] is True
        assert res["pr_url"] == "https://github.com/xtcamille/hermes-forx/pull/1001"
        assert res["pr_number"] == 1001


def test_cli_presentation(tmp_path, monkeypatch):
    skill_dir = tmp_path / "cli-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: cli-skill\n"
        "description: CLI test skill\n"
        "---\n"
        "Testing CLI",
        encoding="utf-8",
    )

    # Test check command
    code = cli._run_check(str(skill_dir), "skill")
    assert code == 0

    # Test auth check command
    monkeypatch.setattr(
        cli,
        "get_auth_status",
        lambda auth=None: {"authenticated": True, "method": "gh-cli", "username": "bob"},
    )
    assert cli._run_auth() == 0


def test_api_routes(tmp_path, monkeypatch):
    name = "forx_publisher_api_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard/plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)

    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    client = TestClient(app)

    # 1. /auth
    monkeypatch.setattr(
        mod.publisher,
        "get_auth_status",
        lambda auth=None: {"authenticated": True, "method": "pat", "username": "tester"},
    )
    resp = client.get(f"{PREFIX}/auth")
    assert resp.status_code == 200
    assert resp.json()["username"] == "tester"

    # 2. /check
    skill_dir = tmp_path / "api-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: api-skill\n"
        "description: API test skill\n"
        "---\n"
        "Testing API",
        encoding="utf-8",
    )

    resp = client.post(f"{PREFIX}/check", json={"path": str(skill_dir), "target_type": "skill"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert resp.json()["name"] == "api-skill"


def test_auth_token_save_and_clear_lifecycle(tmp_path, monkeypatch):
    """Saving a valid PAT persists GITHUB_TOKEN to the active HERMES_HOME .env; clearing removes it."""
    hermes_home = tmp_path / "hermes-home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    name = "forx_publisher_api_test_" + uuid.uuid4().hex
    spec = importlib.util.spec_from_file_location(name, PLUGIN_ROOT / "dashboard/plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)

    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    client = TestClient(app)

    def _mock_user_get(url, headers=None, timeout=10):
        resp = MagicMock()
        auth_header = (headers or {}).get("Authorization", "")
        if auth_header == "token ghp_validtoken123":
            resp.status_code = 200
            resp.headers = {"X-OAuth-Scopes": "public_repo, read:user"}
            resp.json.return_value = {"login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/1"}
        elif auth_header == "token ghp_noscope123":
            resp.status_code = 200
            resp.headers = {"X-OAuth-Scopes": "read:user"}
            resp.json.return_value = {"login": "octocat"}
        else:
            resp.status_code = 401
            resp.headers = {}
        return resp

    monkeypatch.setattr(mod.publisher.httpx, "get", _mock_user_get)
    monkeypatch.setattr(mod.publisher.GitHubAuth, "_try_gh_cli", lambda self: None)

    # Rejects token missing public_repo/repo scope
    bad_scope = client.post(f"{PREFIX}/auth/token", json={"token": "ghp_noscope123"})
    assert bad_scope.status_code == 400
    assert "public_repo" in bad_scope.json()["detail"]

    # Rejects invalid token
    bad_tok = client.post(f"{PREFIX}/auth/token", json={"token": "ghp_bad"})
    assert bad_tok.status_code == 400

    # Saves valid token into temp HERMES_HOME/.env and updates status
    ok_resp = client.post(f"{PREFIX}/auth/token", json={"token": "ghp_validtoken123"})
    assert ok_resp.status_code == 200
    assert ok_resp.json()["authenticated"] is True
    assert ok_resp.json()["username"] == "octocat"
    env_text = (hermes_home / ".env").read_text(encoding="utf-8")
    assert "GITHUB_TOKEN=" in env_text
    assert "ghp_validtoken123" in env_text

    # Deleting clears GITHUB_TOKEN from .env
    del_resp = client.delete(f"{PREFIX}/auth/token")
    assert del_resp.status_code == 200
    assert del_resp.json()["removed"] is True
    assert "ghp_validtoken123" not in (hermes_home / ".env").read_text(encoding="utf-8")


def test_plugin_registration(publisher_module):
    """Verify plugin register(ctx) registers expected CLI, slash commands, tools, and skill."""
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
    publisher_module.register(ctx)

    assert "publish" in ctx.cli_commands
    assert "publish" in ctx.commands
    assert "forx_publish_check" in ctx.tools
    assert "forx_publish_plugin" in ctx.tools
    assert "forx_publish_skill" in ctx.tools
    assert "forx-publish" in ctx.skills
