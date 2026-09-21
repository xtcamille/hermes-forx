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
                "data": {"id": 1, "username": data.get("username", "testuser"), "role": 1}
            })
        if "/api/token" in path:
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

    def test_login_auto_provisions_token_when_none_exists(self, fake_lattice, tmp_path, monkeypatch):
        home = tmp_path / "hermes_home"
        home.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("HERMES_HOME", str(home))

        fake_lattice.user_tokens = []

        from argparse import Namespace
        from hermes_cli.auth_lattice import lattice_auth_handler, current_lattice_state

        monkeypatch.setattr("builtins.input", lambda prompt: "fresh_user")
        monkeypatch.setattr("getpass.getpass", lambda prompt: "pass123")

        handled = lattice_auth_handler("add", Namespace())
        assert handled is True

        state = current_lattice_state()
        assert state["api_key"].startswith("sk-created-test-")
        assert len(fake_lattice.user_tokens) == 1

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
