"""Regression tests for profile-scoped dashboard Channels endpoints.

Before the ``profile`` parameter existed, ``/api/messaging/platforms`` always
read/wrote the dashboard process's own (root) ``.env`` via ``load_env()`` /
``save_env_value()`` — so a dashboard switched to a freshly created profile
still displayed and persisted the ROOT install's messaging credentials.
These tests pin the new behavior: reads and writes land in the REQUESTED
profile's HERMES_HOME, and the dashboard's own profile stays untouched.
"""
import pytest
import yaml
import gateway.status as _gw_status


_VALID_WORKER_BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234"
_VALID_BODY_BOT_TOKEN = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_4321"


@pytest.fixture
def isolated_profiles(tmp_path, monkeypatch, _isolate_hermes_home):
    """Isolated default home + one named profile, each with its own .env."""
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker_home = profiles_root / "worker_alpha"
    for home in (default_home, worker_home):
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")

    (default_home / ".env").write_text(
        "TELEGRAM_BOT_TOKEN=root-token\n", encoding="utf-8"
    )
    (worker_home / ".env").write_text("", encoding="utf-8")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": worker_home}


@pytest.fixture
def client(monkeypatch, isolated_profiles):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    # The dashboard process's os.environ may carry root-install credentials;
    # make sure the scoped path never falls back to them.
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _telegram(payload):
    return next(p for p in payload["platforms"] if p["id"] == "telegram")


def _env_field(platform, key):
    return next(f for f in platform["env_vars"] if f["key"] == key)


class TestProfileScopedMessagingReads:
    def test_scoped_read_does_not_show_root_credentials(
        self, client, isolated_profiles
    ):
        resp = client.get(
            "/api/messaging/platforms", params={"profile": "worker_alpha"}
        )
        assert resp.status_code == 200
        telegram = _telegram(resp.json())
        token = _env_field(telegram, "TELEGRAM_BOT_TOKEN")
        # The worker profile has an empty .env — the root token must not leak.
        assert token["is_set"] is False
        assert telegram["configured"] is False


    def test_unknown_profile_returns_404(self, client, isolated_profiles):
        resp = client.get(
            "/api/messaging/platforms", params={"profile": "no_such_profile"}
        )
        assert resp.status_code == 404

    def test_scoped_read_returns_profile_path_command_and_startup_failure(
        self, client, isolated_profiles, monkeypatch
    ):
        import hermes_cli.web_server as web_server

        worker_home = isolated_profiles["worker_alpha"]
        (worker_home / ".env").write_text(
            "TELEGRAM_BOT_TOKEN=worker-token\n", encoding="utf-8"
        )
        (worker_home / "config.yaml").write_text(
            yaml.safe_dump({"platforms": {"telegram": {"enabled": True}}}),
            encoding="utf-8",
        )
        monkeypatch.setattr(_gw_status, "get_running_pid", lambda *a, **k: None)
        monkeypatch.setattr(
            _gw_status, "get_running_pid_cached", lambda *a, **k: None
        )
        monkeypatch.setattr(
            _gw_status,
            "read_runtime_status",
            # Accepts path= : the profile-scoped read now passes the
            # profile's own gateway_state.json explicitly rather than
            # relying on process-level HERMES_HOME resolution (#71211).
            lambda *a, **k: {
                "gateway_state": "startup_failed",
                "exit_reason": "all configured messaging platforms failed to connect",
                "platforms": {},
            },
        )

        resp = client.get(
            "/api/messaging/platforms", params={"profile": "worker_alpha"}
        )

        assert resp.status_code == 200
        payload = resp.json()
        assert payload["env_path"] == str(worker_home / ".env")
        assert payload["gateway_start_command"] == (
            "hermes -p worker_alpha gateway start"
        )
        telegram = _telegram(payload)
        assert telegram["state"] == "startup_failed"
        assert telegram["error_code"] == "startup_failed"
        assert telegram["error_message"] == (
            "all configured messaging platforms failed to connect"
        )


class TestProfileScopedMessagingWrites:
    def test_scoped_write_lands_in_target_profile_env(
        self, client, isolated_profiles
    ):
        resp = client.put(
            "/api/messaging/platforms/telegram",
            params={"profile": "worker_alpha"},
            json={
                "enabled": True,
                "env": {"TELEGRAM_BOT_TOKEN": _VALID_WORKER_BOT_TOKEN},
            },
        )
        assert resp.status_code == 200

        worker_env = (
            isolated_profiles["worker_alpha"] / ".env"
        ).read_text(encoding="utf-8")
        assert f"TELEGRAM_BOT_TOKEN={_VALID_WORKER_BOT_TOKEN}" in worker_env

        # The dashboard's own .env must stay untouched — this was the bug.
        root_env = (isolated_profiles["default"] / ".env").read_text(
            encoding="utf-8"
        )
        assert _VALID_WORKER_BOT_TOKEN not in root_env
        assert "TELEGRAM_BOT_TOKEN=root-token" in root_env

        # Enablement lands in the target profile's config.yaml.
        worker_cfg = yaml.safe_load(
            (isolated_profiles["worker_alpha"] / "config.yaml").read_text(encoding="utf-8")
        ) or {}
        assert worker_cfg.get("platforms", {}).get("telegram", {}).get("enabled") is True
        root_cfg = yaml.safe_load(
            (isolated_profiles["default"] / "config.yaml").read_text(encoding="utf-8")
        ) or {}
        assert "telegram" not in (root_cfg.get("platforms") or {})


    def test_scoped_read_after_scoped_write_round_trips(
        self, client, isolated_profiles
    ):
        client.put(
            "/api/messaging/platforms/telegram",
            params={"profile": "worker_alpha"},
            json={
                "enabled": True,
                "env": {"TELEGRAM_BOT_TOKEN": _VALID_WORKER_BOT_TOKEN},
            },
        )
        resp = client.get(
            "/api/messaging/platforms", params={"profile": "worker_alpha"}
        )
        telegram = _telegram(resp.json())
        assert telegram["enabled"] is True
        assert _env_field(telegram, "TELEGRAM_BOT_TOKEN")["is_set"] is True
        assert telegram["configured"] is True



def _enable_multiplex(default_home):
    (default_home / "config.yaml").write_text(
        yaml.safe_dump({"gateway": {"multiplex_profiles": True}}),
        encoding="utf-8",
    )


class TestMultiplexPortBindingGuard:
    """Enabling api_server/webhook on a secondary multiplexed profile is rejected BEFORE anything
    is persisted: the default profile's listener already mirrors them at ``/p/<profile>/`` (#62791).
    Every other inbound-port platform is allowed — the gateway serves it on the shared listener.
    """

    @pytest.fixture(autouse=True)
    def _no_multiplex_env_override(self, monkeypatch):
        # The operator env override must not leak into these tests: the
        # multiplex flag under test comes from the default profile's config.
        monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)

    def test_rejects_only_mirrored_listeners_on_secondary(
        self, client, isolated_profiles
    ):
        from gateway.config import PORT_BINDING_PLATFORM_VALUES, SHARED_LISTENER_MIRROR_PLATFORMS

        _enable_multiplex(isolated_profiles["default"])
        assert SHARED_LISTENER_MIRROR_PLATFORMS  # guard set must not be empty
        catalog = {p["id"] for p in client.get("/api/messaging/platforms").json()["platforms"]}
        for platform_id in sorted(PORT_BINDING_PLATFORM_VALUES & catalog):
            resp = client.put(
                f"/api/messaging/platforms/{platform_id}",
                params={"profile": "worker_alpha"},
                json={"enabled": True},
            )
            if platform_id in SHARED_LISTENER_MIRROR_PLATFORMS:
                assert resp.status_code == 409, platform_id
                assert "default profile" in resp.json()["detail"]
            else:  # served at /p/worker_alpha/<path> on the shared listener
                assert resp.status_code == 200, (platform_id, resp.text)





    def test_secondary_can_disable_and_clear_invalid_config(
        self, client, isolated_profiles
    ):
        _enable_multiplex(isolated_profiles["default"])
        worker_home = isolated_profiles["worker_alpha"]
        (worker_home / "config.yaml").write_text(
            yaml.safe_dump({"platforms": {"api_server": {"enabled": True}}}),
            encoding="utf-8",
        )

        resp = client.put(
            "/api/messaging/platforms/api_server",
            params={"profile": "worker_alpha"},
            json={"enabled": False},
        )
        assert resp.status_code == 200
        cfg = yaml.safe_load((worker_home / "config.yaml").read_text(encoding="utf-8"))
        assert cfg["platforms"]["api_server"]["enabled"] is False

        catalog = client.get(
            "/api/messaging/platforms", params={"profile": "worker_alpha"}
        ).json()
        api_server = next(p for p in catalog["platforms"] if p["id"] == "api_server")
        if api_server["env_vars"]:
            resp = client.put(
                "/api/messaging/platforms/api_server",
                params={"profile": "worker_alpha"},
                json={"clear_env": [api_server["env_vars"][0]["key"]]},
            )
            assert resp.status_code == 200

def test_named_current_home_matches_unscoped(client, isolated_profiles, monkeypatch):
    from hermes_cli.web_server_profiles import _config_profile_scope, _hermes_home_scope
    from hermes_constants import get_hermes_home

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "root-token")
    for scope in (None, "current", "default"):
        response = client.get("/api/messaging/platforms", params={"profile": scope} if scope else {})
        assert response.status_code == 200
        assert _telegram(response.json())["enabled"] is True
    with _hermes_home_scope(isolated_profiles["worker_alpha"]):
        with _config_profile_scope("default") as scoped:
            assert scoped is None
            assert get_hermes_home() == isolated_profiles["default"]


def test_scoped_enablement_uses_only_own_credentials(client, isolated_profiles, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "root-token")
    worker = isolated_profiles["worker_alpha"]
    params = {"profile": "worker_alpha"}
    assert _telegram(client.get("/api/messaging/platforms", params=params).json())["enabled"] is False
    (worker / ".env").write_text("TELEGRAM_BOT_TOKEN=worker-token\n", encoding="utf-8")
    payload = client.get("/api/messaging/platforms", params=params).json()
    assert _telegram(payload)["enabled"] is True
    assert _telegram(payload)["configured"] is True
    assert _telegram(payload)["state"] != "disabled"
    from hermes_cli.web_server_messaging import _messaging_platform_catalog
    empty = {entry["id"] for entry in _messaging_platform_catalog() if not entry["required_env"]}
    for platform in payload["platforms"]:
        if platform["id"] in empty:
            assert platform["enabled"] is False
            assert platform["configured"] is False
    for enabled in (False, True):
        (worker / "config.yaml").write_text(yaml.safe_dump({"platforms": {"telegram": {"enabled": enabled}}}), encoding="utf-8")
        platform = _telegram(client.get("/api/messaging/platforms", params=params).json())
        assert platform["enabled"] is enabled
        assert platform["configured"] is True
    assert "root-token" in (isolated_profiles["default"] / ".env").read_text(encoding="utf-8")


@pytest.mark.parametrize("topology", ["scoped_query", "pooled_unscoped"])
def test_credential_write_hot_serves_a_multiplexed_profile(client, isolated_profiles, monkeypatch, topology):
    """A token saved for a profile the live multiplexer serves is handed to the multiplexer right
    away (``hot_served``), so the UI skips its restart banner. Both Desktop topologies: the dashboard's
    ``?profile=`` and a pooled ``hermes --profile X serve`` that receives the PUT unscoped (#109088)."""
    import hermes_cli.gateway as gateway_cli
    import hermes_cli.gateway_multiplex_served as served_mod
    notified = []
    monkeypatch.setattr(gateway_cli, "named_profile_served_by_running_multiplexer", lambda name=None: name == "worker_alpha")
    monkeypatch.setattr(served_mod, "notify_multiplexer_profiles_changed", lambda name, **kw: notified.append(name) or ["default", name])
    if topology == "pooled_unscoped":
        monkeypatch.setattr(gateway_cli, "_current_profile_name", lambda: "worker_alpha")
        params = {}
    else:
        params = {"profile": "worker_alpha"}
    resp = client.put("/api/messaging/platforms/telegram", params=params,
                      json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": _VALID_WORKER_BOT_TOKEN}})
    assert resp.status_code == 200
    assert resp.json()["hot_served"] is True
    assert notified == ["worker_alpha"]


def test_credential_write_on_default_profile_is_not_hot_served(client, isolated_profiles, monkeypatch):
    """The default profile is the multiplexer itself (its own adapters are restart-managed): never
    claim a hot serve for it."""
    import hermes_cli.gateway_multiplex_served as served_mod
    monkeypatch.setattr(served_mod, "notify_multiplexer_profiles_changed",
                        lambda name, **kw: pytest.fail("default profile must not ping the multiplexer"))
    resp = client.put("/api/messaging/platforms/telegram",
                      json={"enabled": True, "env": {"TELEGRAM_BOT_TOKEN": _VALID_WORKER_BOT_TOKEN}})
    assert resp.status_code == 200
    assert resp.json()["hot_served"] is False


class TestWeixinOnboardingAndDependencies:
    def test_weixin_dependencies_and_profile_scoped_qr_onboarding(
        self, client, isolated_profiles, monkeypatch
    ):
        import contextlib
        import gateway.platforms.weixin as wx_mod
        import hermes_cli.web_server_messaging as wsm
        import hermes_cli.web_routers.messaging as msg_router
        import tools.lazy_deps as lazy_deps

        with wsm._weixin_onboarding_lock:
            wsm._weixin_onboarding_sessions.clear()

        installed_calls = []
        state = {
            "aiohttp": False,
            "cryptography": False,
            "certifi": False,
            "pilk": False,
        }

        def fake_refresh():
            return dict(state)

        def fake_install_specs(specs, label=""):
            installed_calls.append(list(specs))
            for spec in specs:
                pkg = spec.split("==", 1)[0]
                state[pkg] = True
            wx_mod.AIOHTTP_AVAILABLE = True
            wx_mod.CRYPTO_AVAILABLE = True
            return True

        monkeypatch.setattr(wx_mod, "refresh_weixin_requirements", fake_refresh)
        monkeypatch.setattr(lazy_deps, "install_specs", fake_install_specs)

        dep_resp = client.get(
            "/api/messaging/weixin/dependencies", params={"profile": "worker_alpha"}
        )
        assert dep_resp.status_code == 200
        assert dep_resp.json()["ok"] is False
        assert set(dep_resp.json()["missing_required"]) == {"aiohttp", "cryptography"}

        inst_resp = client.post(
            "/api/messaging/weixin/dependencies/install",
            params={"profile": "worker_alpha"},
            json={"include_optional": False, "profile": "worker_alpha"},
        )
        assert inst_resp.status_code == 200
        assert inst_resp.json()["ok"] is True
        assert installed_calls == [["aiohttp==3.14.3", "cryptography==50.0.0"]]

        @contextlib.asynccontextmanager
        async def fake_new_session():
            yield object()

        async def fake_fetch_qr(session, bot_type="3"):
            return ("wx-qr-ticket-1", "https://ilinkai.weixin.qq.com/qr/wx-qr-ticket-1")

        async def fake_api_get(session, *, base_url, endpoint, timeout_ms):
            assert "wx-qr-ticket-1" in endpoint
            return {
                "status": "confirmed",
                "bot_token": "wx-secret-bot-token",
                "ilink_bot_id": "wx_bot_acct_42",
                "ilink_user_id": "wxid_owner_888",
                "baseurl": "https://ilinkai.weixin.qq.com",
            }

        monkeypatch.setattr(wx_mod, "_new_session", fake_new_session)
        monkeypatch.setattr(wx_mod, "_fetch_qr", fake_fetch_qr)
        monkeypatch.setattr(wx_mod, "_api_get", fake_api_get)
        monkeypatch.setattr(
            msg_router,
            "_restart_gateway_after_weixin_onboarding",
            lambda profile=None: {"restart_started": True, "restart_error": None},
        )

        start_resp = client.post(
            "/api/messaging/weixin/onboarding/start",
            params={"profile": "worker_alpha"},
            json={
                "bot_type": "3",
                "dm_policy": "allowlist",
                "allowed_users": "",
                "group_policy": "disabled",
                "group_allowed_users": "",
                "set_home_channel": True,
                "profile": "worker_alpha",
            },
        )
        assert start_resp.status_code == 200
        start_data = start_resp.json()
        pairing_id = start_data["pairing_id"]

        # Wait briefly for the background onboarding thread to complete the mocked poll
        import time as _time
        for _ in range(40):
            poll_resp = client.get(
                f"/api/messaging/weixin/onboarding/{pairing_id}",
                params={"profile": "worker_alpha"},
            )
            assert poll_resp.status_code == 200
            poll_data = poll_resp.json()
            if poll_data["status"] == "connected":
                break
            _time.sleep(0.05)

        assert poll_data["status"] == "connected"
        assert poll_data["account_id"] == "wx_bot_acct_42"
        assert poll_data["user_id"] == "wxid_owner_888"
        assert "token" not in poll_data

        apply_resp = client.post(
            f"/api/messaging/weixin/onboarding/{pairing_id}/apply",
            params={"profile": "worker_alpha"},
            json={
                "dm_policy": "allowlist",
                "allowed_users": "wxid_owner_888",
                "group_policy": "disabled",
                "group_allowed_users": "",
                "set_home_channel": True,
                "profile": "worker_alpha",
            },
        )
        assert apply_resp.status_code == 200
        apply_data = apply_resp.json()
        assert apply_data["ok"] is True
        assert apply_data["account_id"] == "wx_bot_acct_42"
        assert apply_data["user_id"] == "wxid_owner_888"
        assert apply_data["restart_started"] is True

        worker_home = isolated_profiles["worker_alpha"]
        worker_env = (worker_home / ".env").read_text(encoding="utf-8")
        assert "WEIXIN_ACCOUNT_ID=wx_bot_acct_42" in worker_env
        assert "WEIXIN_TOKEN=wx-secret-bot-token" in worker_env
        assert "WEIXIN_DM_POLICY=allowlist" in worker_env
        assert "WEIXIN_ALLOWED_USERS=wxid_owner_888" in worker_env
        assert "WEIXIN_HOME_CHANNEL=wxid_owner_888" in worker_env

        # Root profile .env must remain untouched
        root_env = (isolated_profiles["default"] / ".env").read_text(encoding="utf-8")
        assert "wx-secret-bot-token" not in root_env

        # Account file saved inside worker_alpha's HERMES_HOME
        acct_file = worker_home / "weixin" / "accounts" / "wx_bot_acct_42.json"
        assert acct_file.exists()

        # Platform payload includes weixin_setup metadata
        platforms_resp = client.get(
            "/api/messaging/platforms", params={"profile": "worker_alpha"}
        )
        weixin_plat = next(
            p for p in platforms_resp.json()["platforms"] if p["id"] == "weixin"
        )
        assert weixin_plat["enabled"] is True
        assert weixin_plat["configured"] is True
        assert weixin_plat["weixin_setup"]["account_id"] == "wx_bot_acct_42"
        assert weixin_plat["weixin_setup"]["dm_policy"] == "allowlist"
        assert weixin_plat["weixin_setup"]["allowed_users"] == "wxid_owner_888"
        assert weixin_plat["weixin_setup"]["home_channel"] == "wxid_owner_888"

        # Policy update via /api/messaging/weixin/config
        cfg_resp = client.post(
            "/api/messaging/weixin/config",
            params={"profile": "worker_alpha"},
            json={
                "dm_policy": "pairing",
                "allowed_users": "wxid_owner_888,wxid_friend_2",
                "group_policy": "allowlist",
                "group_allowed_users": "wxid_owner_888",
                "set_home_channel": True,
                "home_channel_id": "wxid_owner_888",
                "profile": "worker_alpha",
            },
        )
        assert cfg_resp.status_code == 200
        assert cfg_resp.json()["ok"] is True
        worker_env_after = (worker_home / ".env").read_text(encoding="utf-8")
        assert "WEIXIN_DM_POLICY=pairing" in worker_env_after
        assert "WEIXIN_ALLOWED_USERS=wxid_owner_888,wxid_friend_2" in worker_env_after
        assert "WEIXIN_GROUP_POLICY=allowlist" in worker_env_after


