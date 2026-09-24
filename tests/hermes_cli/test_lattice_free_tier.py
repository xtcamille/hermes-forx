"""Tests for LatticeCode Free Tier (MVP).

Validates:
- Provider discovery & registration
- Anonymous identity minting and JWT exchange
- Provider resolution ladder (Priority preservation)
- Multi-model whitelist and route pinning
- Auxiliary client resolution
- Error classification for anonymous requests
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict

import httpx
import pytest

from hermes_cli import auth_lattice
from hermes_cli.auth import _load_auth_store, resolve_provider
from hermes_cli.free_tiers import get_active_free_tier, is_anonymous_request
from hermes_cli.model_switch_providers import _free_tier_lattice_row
from hermes_constants import get_hermes_home


class FakeLatticeServer:
    def __init__(self):
        self.mint_count = 0
        self.exchange_count = 0
        self.tokens: Dict[str, str] = {}
        self.token_allowed_models = None
        self.token_default_model = None
        self.models_endpoint_models = None
        self.user_tokens: list = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/anonymous/create"):
            self.mint_count += 1
            token = f"anon_lattice_test_{self.mint_count}"
            self.tokens[token] = f"jwt_access_{self.mint_count}"
            return httpx.Response(201, json={"device_id": f"dev_{self.mint_count}", "token": token, "tier": "free"})
        if path.endswith("/anonymous/token"):
            self.exchange_count += 1
            data = json.loads(request.content.decode("utf-8"))
            token = data.get("token")
            if token in self.tokens:
                body = {
                    "access_token": self.tokens[token],
                    "expires_in": 3600,
                    "inference_base_url": "https://api.latticecode.test/v1"
                }
                if self.token_allowed_models is not None:
                    body["allowed_models"] = self.token_allowed_models
                if self.token_default_model is not None:
                    body["default_model"] = self.token_default_model
                return httpx.Response(200, json=body)
            return httpx.Response(404, json={"error": "unknown_token"})
        if path.endswith("/models"):
            models = self.models_endpoint_models or ["latticecode/free-coder", "latticecode/free-chat"]
            return httpx.Response(200, json={"object": "list", "data": [{"id": m, "object": "model"} for m in models]})
        if path.endswith("/api/user/login"):
            data = json.loads(request.content.decode("utf-8"))
            if data.get("password") == "bad_pass":
                return httpx.Response(200, json={"success": False, "message": "Invalid password"})
            return httpx.Response(200, json={
                "success": True, "message": "",
                "data": {
                    "access_token": "jwt_test_access_token",
                    "id": 1,
                    "username": data.get("username", "testuser"),
                    "role": 1
                }
            })
        if "/api/pricing" in path:
            return httpx.Response(200, json={
                "success": True,
                "data": [{"model_name": "deepseek-v4.1-flash"}, {"model_name": "qwen3.8-flash"}]
            })
        if "/api/token/batch/keys" in path:
            auth = request.headers.get("Authorization")
            if not auth or "Bearer jwt_test_access_token" not in auth:
                return httpx.Response(401, json={"success": False, "message": "Unauthorized, invalid access token"})
            data = json.loads(request.content.decode("utf-8"))
            ids = data.get("ids") or []
            keys = {}
            for t in self.user_tokens:
                if t.get("id") in ids:
                    keys[str(t["id"])] = t.get("unmasked_key") or t.get("key")
            return httpx.Response(200, json={"success": True, "data": {"keys": keys}})
        if "/api/token" in path:
            auth = request.headers.get("Authorization")
            if not auth or "Bearer jwt_test_access_token" not in auth:
                return httpx.Response(401, json={"success": False, "message": "Unauthorized, invalid access token"})
            if request.method == "GET":
                return httpx.Response(200, json={"success": True, "data": self.user_tokens})
            elif request.method == "POST":
                new_key = f"sk-created-test-{len(self.user_tokens) + 1}"
                token_entry = {"id": len(self.user_tokens) + 1, "name": "Hermes Agent", "key": new_key, "status": 1}
                self.user_tokens.append(token_entry)
                return httpx.Response(200, json={"success": True, "data": token_entry})
        return httpx.Response(404)


@pytest.fixture
def fake_lattice(monkeypatch):
    server = FakeLatticeServer()
    transport = httpx.MockTransport(server.handler)

    class MockHttpxClient(httpx.Client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(auth_lattice.httpx, "Client", MockHttpxClient)
    return server


class TestLatticeProviderPlugin:
    def test_provider_is_registered(self):
        import providers
        providers._discovered = False
        providers._PROVIDER_LIST_CACHE = None
        from providers import list_providers
        names = [p.name for p in list_providers()]
        assert "latticecode" in names

    def test_provider_attributes(self):
        import providers
        providers._discovered = False
        providers._PROVIDER_LIST_CACHE = None
        from providers import get_provider_profile
        profile = get_provider_profile("latticecode")
        assert profile is not None
        assert profile.display_name == "LatticeCode Free"
        assert "latticecode/free-coder" in profile.fallback_models
        assert profile.default_aux_model == "latticecode/free-coder"


class TestLatticeIdentityLifecycle:
    def test_fresh_install_mints_and_persists_identity(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        state = auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)
        assert state is not None
        assert state["auth_method"] == "anonymous"
        assert state["anon_token"].startswith("anon_lattice_test_")
        assert state["access_token"].startswith("jwt_access_")
        assert fake_lattice.mint_count == 1
        assert fake_lattice.exchange_count == 1

        # Second call does not hit network
        state2 = auth_lattice.ensure_lattice_identity(explicit=True)
        assert state2["anon_token"] == state["anon_token"]
        assert fake_lattice.mint_count == 1

        # auth.json has active_provider = latticecode
        store = _load_auth_store()
        assert store["active_provider"] == "latticecode"
        assert "latticecode" in store["providers"]

    def test_runtime_credentials_return_valid_tokens(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        creds = auth_lattice.resolve_lattice_runtime_credentials()
        assert creds["api_key"].startswith("jwt_access_")
        assert "https://" in creds["base_url"]


class TestLatticePriorityResolution:
    def test_blank_install_resolves_to_latticecode(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        # Bootstrap establishes identity
        auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)

        tier = get_active_free_tier()
        assert tier is not None
        assert tier.provider_id == "latticecode"

        resolved = resolve_provider("auto")
        assert resolved == "latticecode"

    def test_user_api_key_preempts_free_tier(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        # Establish free tier first
        auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)

        # Now simulate user adding an API key to env
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-testkey")

        # resolve_provider should now prefer anthropic
        resolved = resolve_provider("auto")
        assert resolved == "anthropic"

    def test_explicit_provider_always_wins(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-testkey")

        auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)

        # Explicit user switch to latticecode
        resolved = resolve_provider("latticecode")
        assert resolved == "latticecode"


class TestMultiModelWhitelistAndPinning:
    def test_allowed_free_models_are_preserved(self):
        endpoint = "https://api.latticecode.com/v1"
        assert auth_lattice.pin_lattice_model(endpoint, "latticecode/free-coder") == "latticecode/free-coder"
        assert auth_lattice.pin_lattice_model(endpoint, "latticecode/free-chat") == "latticecode/free-chat"
        assert auth_lattice.pin_lattice_model(endpoint, "latticecode/free-r1") == "latticecode/free-r1"

    def test_unauthorized_external_model_is_corrected(self):
        endpoint = "https://api.latticecode.com/v1"
        # gpt-4o should be corrected to default free coder
        assert auth_lattice.pin_lattice_model(endpoint, "gpt-4o") == "latticecode/free-coder"
        assert auth_lattice.pin_lattice_model(endpoint, "claude-3-5-sonnet") == "latticecode/free-coder"

    def test_picker_row_includes_all_models(self):
        row = {"name": "latticecode", "models": []}
        picker_row = _free_tier_lattice_row(row)
        assert picker_row is not None
        assert picker_row["free_tier_row"] is True
        assert picker_row["name"] == "LatticeCode Free"
        assert "latticecode/free-coder" in picker_row["models"]
        assert "latticecode/free-chat" in picker_row["models"]
        assert "latticecode/free-r1" in picker_row["models"]

    def test_dynamic_models_via_token_exchange(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        # Server announces custom allowed models via token exchange payload
        fake_lattice.token_allowed_models = ["latticecode/special-coder", "latticecode/special-chat"]
        fake_lattice.token_default_model = "latticecode/special-coder"

        state = auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)
        assert state is not None
        assert state["allowed_models"] == ["latticecode/special-coder", "latticecode/special-chat"]

        # get_lattice_allowed_models should now reflect the server-synced models
        active_models = auth_lattice.get_lattice_allowed_models()
        assert "latticecode/special-coder" in active_models
        assert "latticecode/special-chat" in active_models
        assert "latticecode/free-r1" not in active_models

        # Model pinning respects the dynamic model list
        endpoint = "https://api.latticecode.com/v1"
        assert auth_lattice.pin_lattice_model(endpoint, "latticecode/special-coder") == "latticecode/special-coder"
        # Old default is now corrected to the new dynamic default
        assert auth_lattice.pin_lattice_model(endpoint, "latticecode/free-r1") == "latticecode/special-coder"

        # Model picker row also renders the dynamic models
        picker_row = _free_tier_lattice_row({"name": "latticecode", "models": []})
        assert picker_row["models"] == ["latticecode/special-chat", "latticecode/special-coder"]

    def test_dynamic_models_via_v1_models_endpoint(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        # Establish identity with defaults first
        auth_lattice.ensure_lattice_identity(explicit=True, carries_inference=True)

        # Server publishes new models under /v1/models
        fake_lattice.models_endpoint_models = ["latticecode/v2-deep-think", "latticecode/v2-fast"]

        # Trigger sync from server
        synced = auth_lattice.sync_lattice_models_from_server()
        assert synced == ["latticecode/v2-deep-think", "latticecode/v2-fast"]

        # Cache is updated
        assert auth_lattice.get_lattice_allowed_models() == frozenset({"latticecode/v2-deep-think", "latticecode/v2-fast"})
        picker_row = _free_tier_lattice_row({"name": "latticecode", "models": []})
        assert picker_row["models"] == ["latticecode/v2-deep-think", "latticecode/v2-fast"]


class TestErrorClassificationAndAuxiliary:
    def test_is_anonymous_request(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        state = auth_lattice.ensure_lattice_identity(explicit=True)
        jwt = state["access_token"]

        assert is_anonymous_request("latticecode", jwt) is True
        assert is_anonymous_request("latticecode", "sk-random-real-key") is False
        assert is_anonymous_request("openrouter", jwt) is False

    def test_auxiliary_client_resolves(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        auth_lattice.ensure_lattice_identity(explicit=True)

        from agent.auxiliary_client import resolve_provider_client
        client, model = resolve_provider_client("latticecode")
        assert client is not None
        assert model == "latticecode/free-coder"


class TestLatticeAccountAuth:
    def test_login_fetches_existing_new_api_token(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        fake_lattice.user_tokens = [{"id": 1, "name": "Default", "key": "sk-existing-new-api-key", "status": 1}]

        from argparse import Namespace
        from hermes_cli.auth_lattice import lattice_auth_handler, current_lattice_state, resolve_lattice_runtime_credentials
        from hermes_cli.auth import get_auth_status

        monkeypatch.setattr("builtins.input", lambda prompt: "test_dev@example.com")
        monkeypatch.setattr("getpass.getpass", lambda prompt: "secret123")

        handled = lattice_auth_handler("login", Namespace())
        assert handled is True

        state = current_lattice_state()
        assert state is not None
        assert state["auth_method"] == "password"
        assert state["api_key"] == "sk-existing-new-api-key"
        assert state["username"] == "test_dev@example.com"

        status = get_auth_status("latticecode")
        assert status["logged_in"] is True
        assert status["username"] == "test_dev@example.com"

        creds = resolve_lattice_runtime_credentials()
        assert creds["api_key"] == "sk-existing-new-api-key"

        assert is_anonymous_request("latticecode", "sk-existing-new-api-key") is False

    def test_login_fails_when_no_token_exists(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        fake_lattice.user_tokens = []

        from argparse import Namespace
        from hermes_cli.auth_lattice import lattice_auth_handler, current_lattice_state

        monkeypatch.setattr("builtins.input", lambda prompt: "fresh_user")
        monkeypatch.setattr("getpass.getpass", lambda prompt: "pass123")

        handled = lattice_auth_handler("add", Namespace())
        assert handled is False

        state = current_lattice_state()
        assert not state or state.get("auth_method") != "password"
        assert len(fake_lattice.user_tokens) == 0

    def test_login_fails_with_invalid_credentials(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.auth_lattice import login_new_api
        from hermes_cli.auth_constants import AuthError

        with httpx.Client() as client:
            with pytest.raises(AuthError) as exc_info:
                login_new_api(client, "https://api.latticecode.test", "user", "bad_pass")
            assert "Invalid password" in str(exc_info.value)

    def test_logout_reverts_to_anonymous_free_tier(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from argparse import Namespace
        from hermes_cli.auth_lattice import lattice_auth_handler, ensure_lattice_identity, current_lattice_state
        from hermes_cli.auth import get_auth_status

        guest_state = ensure_lattice_identity(explicit=True, carries_inference=True)
        anon_token = guest_state["anon_token"]

        fake_lattice.user_tokens = [{"id": 1, "key": "sk-my-account-key", "status": 1}]
        monkeypatch.setattr("builtins.input", lambda prompt: "alice")
        monkeypatch.setattr("getpass.getpass", lambda prompt: "pwd")
        lattice_auth_handler("login", Namespace())

        assert get_auth_status("latticecode")["logged_in"] is True

        lattice_auth_handler("logout", Namespace())

        st = current_lattice_state()
        assert st["auth_method"] == "anonymous"
        assert st["anon_token"] == anon_token
        assert get_auth_status("latticecode")["logged_in"] is False

    @pytest.mark.anyio
    async def test_api_login_endpoint_success_and_failure(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest

        fake_lattice.user_tokens = [{"id": 1, "key": "sk-endpoint-key", "status": 1}]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is True
        assert res["username"] == "alice"
        assert res["provider"] == "latticecode"

        bad_req = LatticeLoginRequest(username="alice", password="bad_pass", portal_url="https://api.latticecode.test")
        bad_res = await latticecode_login_endpoint(bad_req)
        assert bad_res["ok"] is False
        assert "Invalid password" in bad_res["message"]

    @pytest.mark.anyio
    async def test_api_login_fails_when_no_token(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest

        fake_lattice.user_tokens = []  # No tokens exist
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is False
        assert "该账户没有有效token，无可用模型" in res["message"]
        assert len(fake_lattice.user_tokens) == 0  # Does NOT create a token!

    @pytest.mark.anyio
    async def test_api_login_fails_when_all_tokens_disabled(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest

        fake_lattice.user_tokens = [{"id": 1, "key": "sk-disabled", "status": 0}]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is False
        assert "当前token不可用，无可用模型，检查new api账户是否创建了有效token" in res["message"]
        assert len(fake_lattice.user_tokens) == 1  # Does NOT create a token!

    @pytest.mark.anyio
    async def test_api_login_prioritizes_qwen3_8_27b_5090(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest

        fake_lattice.user_tokens = [{"id": 1, "key": "sk-good-key", "status": 1}]
        fake_lattice.models_endpoint_models = ["deepseek-chat", "qwen3.8-27b-5090", "gpt-4o"]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is True
        assert res["model"] == "qwen3.8-27b-5090"
        assert res["models"][0] == "qwen3.8-27b-5090"
        assert set(res["models"]) == {"qwen3.8-27b-5090", "deepseek-chat", "gpt-4o"}

    @pytest.mark.anyio
    async def test_api_login_unmasks_masked_token(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest
        from hermes_cli.auth import get_auth_status
        from hermes_cli.auth_lattice import current_lattice_state

        # User has a token that is masked with asterisks in the list
        fake_lattice.user_tokens = [
            {
                "id": 10,
                "key": "J6ph**********FYYm",
                "unmasked_key": "sk-J6phuuS0Mu7Cx5OGxmVH1Xpd0daP6biLF2JMaUoQU1NTFYYm",
                "status": 1
            }
        ]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is True
        assert res["username"] == "alice"

        st = current_lattice_state()
        assert st["api_key"] == "sk-J6phuuS0Mu7Cx5OGxmVH1Xpd0daP6biLF2JMaUoQU1NTFYYm"
        assert "*" not in st["api_key"]

    @pytest.mark.anyio
    async def test_refresh_lattice_token_switches_to_next_valid(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest
        from hermes_cli.auth_lattice import refresh_lattice_token, current_lattice_state, resolve_lattice_runtime_credentials

        fake_lattice.user_tokens = [
            {"id": 1, "key": "sk-token-1", "status": 1},
            {"id": 2, "key": "sk-token-2", "status": 1},
        ]
        fake_lattice.models_endpoint_models = ["model-a", "qwen3.8-27b-5090"]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is True

        st = current_lattice_state()
        assert st["api_key"] == "sk-token-1"
        assert st["default_model"] == "qwen3.8-27b-5090"

        # Now token-1 is revoked/disabled
        fake_lattice.user_tokens[0]["status"] = 0
        refreshed = refresh_lattice_token(force=True)
        assert refreshed["api_key"] == "sk-token-2"

        creds = resolve_lattice_runtime_credentials(force_refresh=True)
        assert creds["api_key"] == "sk-token-2"

    @pytest.mark.anyio
    async def test_refresh_lattice_token_fails_when_all_revoked(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        from hermes_cli.web_routers.oauth import latticecode_login_endpoint
        from hermes_cli.web_models import LatticeLoginRequest
        from hermes_cli.auth_lattice import refresh_lattice_token
        from hermes_cli.auth_constants import AuthError

        fake_lattice.user_tokens = [{"id": 1, "key": "sk-token-1", "status": 1}]
        fake_lattice.models_endpoint_models = ["model-a"]
        req = LatticeLoginRequest(username="alice", password="pwd", portal_url="https://api.latticecode.test")
        res = await latticecode_login_endpoint(req)
        assert res["ok"] is True

        # Now all tokens are disabled
        fake_lattice.user_tokens[0]["status"] = 0
        with pytest.raises(AuthError) as exc_info:
            refresh_lattice_token(force=True)
        assert "当前token不可用，无可用模型，检查new api账户是否创建了有效token" in str(exc_info.value)

