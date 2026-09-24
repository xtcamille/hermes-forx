"""LatticeCode free tier authentication and identity lifecycle."""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from agent.retry_utils import parse_retry_after_seconds
from hermes_cli.auth_constants import AuthError, _decode_jwt_claims, httpx
from hermes_constants import get_hermes_home, get_default_hermes_root

logger = logging.getLogger("hermes_cli.auth_lattice")

LATTICE_PROVIDER = "latticecode"
LATTICE_AUTH_METHOD = "anonymous"
DEFAULT_LATTICE_PORTAL_URL = "http://192.168.1.206:3000"
DEFAULT_LATTICE_INFERENCE_URL = "http://192.168.1.206:3000/v1"

DEFAULT_LATTICE_ALLOWED_MODELS = frozenset({
    "latticecode/free-coder",
    "latticecode/free-chat",
    "latticecode/free-r1",
})
LATTICE_ALLOWED_MODELS = DEFAULT_LATTICE_ALLOWED_MODELS
DEFAULT_LATTICE_MODEL = "latticecode/free-coder"
LATTICE_DEFAULT_MODEL = DEFAULT_LATTICE_MODEL
LATTICE_LABEL = "LatticeCode Free"

LATTICE_MINT_TIMEOUT_SECONDS = 5.0
LATTICE_TOKEN_REFRESH_INTERVAL_SECONDS = 300.0
LATTICE_GATE_CLOSED = "lattice_gate_closed"
LATTICE_RATE_LIMITED = "lattice_rate_limited"
LATTICE_UNREACHABLE = "lattice_unreachable"
LATTICE_SERVER_ERROR = "lattice_server_error"
LATTICE_TERMINAL_CODES = frozenset({LATTICE_GATE_CLOSED})


@dataclass(frozen=True)
class MintFailure:
    code: str
    error: str
    retryable: bool
    retry_after: float
    not_before: float
    attempts: int = 1

    def remaining(self) -> float:
        return max(0.0, self.not_before - time.monotonic())


_mint_memos: Dict[str, MintFailure] = {}


def _portal_url() -> str:
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly() or {}
        ft_cfg = cfg.get("free_tier") or {}
        if isinstance(ft_cfg, dict) and ft_cfg.get("portal_url"):
            return str(ft_cfg["portal_url"]).rstrip("/")
        providers_cfg = cfg.get("providers") or {}
        if isinstance(providers_cfg, dict) and isinstance(providers_cfg.get("latticecode"), dict):
            p_url = providers_cfg["latticecode"].get("portal_url")
            if p_url:
                return str(p_url).rstrip("/")
    except Exception:
        pass
    from agent.secret_scope import get_secret_str
    return (get_secret_str("LATTICE_PORTAL_URL") or DEFAULT_LATTICE_PORTAL_URL).rstrip("/")


def _inference_url() -> str:
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly() or {}
        ft_cfg = cfg.get("free_tier") or {}
        if isinstance(ft_cfg, dict) and ft_cfg.get("inference_url"):
            return str(ft_cfg["inference_url"]).rstrip("/")
        providers_cfg = cfg.get("providers") or {}
        if isinstance(providers_cfg, dict) and isinstance(providers_cfg.get("latticecode"), dict):
            i_url = providers_cfg["latticecode"].get("base_url")
            if i_url:
                return str(i_url).rstrip("/")
    except Exception:
        pass
    from agent.secret_scope import get_secret_str
    return (get_secret_str("LATTICE_INFERENCE_URL") or DEFAULT_LATTICE_INFERENCE_URL).rstrip("/")


def lattice_guest_enabled() -> bool:
    """True when LatticeCode free tier is enabled for this process."""
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly()
        ft_cfg = cfg.get("free_tier")
        if isinstance(ft_cfg, dict):
            if not ft_cfg.get("enabled", True):
                return False
            provider = ft_cfg.get("provider")
            if provider and provider != LATTICE_PROVIDER:
                return False
            return True
        return True
    except Exception as exc:
        logger.debug("Lattice guest enabled check failed: %s", exc)
        return True


def current_lattice_state() -> Optional[Dict[str, Any]]:
    """Return the currently stored auth state for LatticeCode, or None."""
    try:
        from hermes_cli.auth import get_provider_auth_state
        state = get_provider_auth_state(LATTICE_PROVIDER)
        if isinstance(state, dict):
            return state
    except Exception:
        pass
    return None


def is_lattice_guest_state(state: Any) -> bool:
    return isinstance(state, dict) and state.get("auth_method") == LATTICE_AUTH_METHOD


def has_lattice_guest() -> bool:
    state = current_lattice_state()
    return bool(state and is_lattice_guest_state(state) and state.get("anon_token"))


def is_lattice_anonymous_request(provider: Any, api_key: Any) -> bool:
    if provider != LATTICE_PROVIDER or not api_key:
        return False
    state = current_lattice_state()
    if not state or not is_lattice_guest_state(state):
        return False
    if state.get("auth_method") == "password":
        return False
    return str(api_key).strip() in (str(state.get("access_token", "")).strip(), str(state.get("anon_token", "")).strip())


def is_lattice_welcome_host(base_url: Any) -> bool:
    from urllib.parse import urlparse
    try:
        host = (urlparse(str(base_url or "")).hostname or "").lower()
    except Exception:
        return False
    configured_host = (urlparse(_inference_url()).hostname or "").lower()
    return bool(host and (host == configured_host or "latticecode" in host))


def get_lattice_allowed_models() -> frozenset[str]:
    """Return currently active allowed models (server-synced if available, else default)."""
    state = current_lattice_state()
    if state and (state.get("auth_method") == "password" or state.get("logged_in")):
        allowed = state.get("allowed_models")
        if isinstance(allowed, (list, tuple, set, frozenset)) and len(allowed) > 1:
            return frozenset(allowed)
        try:
            synced = sync_lattice_models_from_server(timeout_seconds=3.0)
            if synced:
                return frozenset(synced)
        except Exception:
            pass
        if isinstance(allowed, (list, tuple, set, frozenset)) and allowed:
            return frozenset(allowed)
    elif state and isinstance(state.get("allowed_models"), (list, tuple, set, frozenset)) and state["allowed_models"]:
        return frozenset(state["allowed_models"])
    return DEFAULT_LATTICE_ALLOWED_MODELS


def get_lattice_default_model() -> str:
    """Return the default model for LatticeCode (server-synced if available, else default)."""
    state = current_lattice_state()
    if state and isinstance(state.get("default_model"), str) and state["default_model"]:
        return state["default_model"]
    allowed = get_lattice_allowed_models()
    if "qwen3.8-27b-5090" in allowed:
        return "qwen3.8-27b-5090"
    return DEFAULT_LATTICE_MODEL


def pin_lattice_model(base_url: Any, model: Any) -> Any:
    if is_lattice_welcome_host(base_url):
        allowed = get_lattice_allowed_models()
        if not model or model not in allowed:
            default_model = get_lattice_default_model()
            logger.info("LatticeCode free tier: using default model %s instead of %s", default_model, model)
            return default_model
    return model


def _memo_key() -> str:
    try:
        return str(get_hermes_home().resolve())
    except Exception:
        return "default"


def _mint_failure_for_profile() -> Optional[MintFailure]:
    key = _memo_key()
    failure = _mint_memos.get(key)
    if failure and time.monotonic() >= failure.not_before and failure.retryable:
        _mint_memos.pop(key, None)
        return None
    return failure


def _note_mint_failure(code: str, error: str, retryable: bool = True, retry_after: Optional[float] = 30.0) -> MintFailure:
    key = _memo_key()
    prev = _mint_memos.get(key)
    attempts = (prev.attempts + 1) if prev else 1
    try:
        wait = float(retry_after) if (retry_after is not None and float(retry_after) > 0) else (30.0 * min(5, attempts))
    except (TypeError, ValueError):
        wait = 30.0 * min(5, attempts)
    failure = MintFailure(code=code, error=error, retryable=retryable, retry_after=wait,
                          not_before=time.monotonic() + wait, attempts=attempts)
    _mint_memos[key] = failure
    return failure


def _clear_mint_failure() -> None:
    _mint_memos.pop(_memo_key(), None)


def mint_lattice_guest(client: httpx.Client, portal_base_url: str) -> Dict[str, Any]:
    """POST /anonymous/create -> {device_id, token, tier}."""
    url = f"{portal_base_url.rstrip('/')}/anonymous/create"
    headers = {"Accept": "application/json", "User-Agent": "hermes-agent"}
    resp = client.post(url, headers=headers, json={})
    if resp.status_code == 429:
        retry_after = parse_retry_after_seconds(resp.headers) or 60.0
        raise AuthError("Rate limited while creating anonymous identity", code=LATTICE_RATE_LIMITED, retry_after=retry_after)
    if resp.status_code >= 500:
        raise AuthError(f"Lattice server error ({resp.status_code})", code=LATTICE_SERVER_ERROR)
    if not resp.is_success:
        raise AuthError(f"Failed to create anonymous identity ({resp.status_code})", code=LATTICE_GATE_CLOSED, retryable=False)
    payload = resp.json() or {}
    token = payload.get("token")
    if not isinstance(token, str) or not token:
        raise AuthError("Lattice sign-up returned no token", code=LATTICE_SERVER_ERROR)
    return payload


def exchange_lattice_jwt(client: httpx.Client, portal_base_url: str, anon_token: str) -> Dict[str, Any]:
    """POST /anonymous/token {token} -> {access_token, expires_in, inference_base_url}."""
    url = f"{portal_base_url.rstrip('/')}/anonymous/token"
    headers = {"Accept": "application/json", "User-Agent": "hermes-agent"}
    resp = client.post(url, headers=headers, json={"token": anon_token})
    if resp.status_code == 404:
        raise AuthError("Token unknown or expired on server", code="unknown_token")
    if resp.status_code == 429:
        retry_after = parse_retry_after_seconds(resp.headers) or 60.0
        raise AuthError("Rate limited while exchanging token", code=LATTICE_RATE_LIMITED, retry_after=retry_after)
    if not resp.is_success:
        raise AuthError(f"Failed to exchange token ({resp.status_code})", code=LATTICE_SERVER_ERROR)
    payload = resp.json() or {}
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise AuthError("Token exchange returned no access token", code=LATTICE_SERVER_ERROR)
    return payload


def _shared_store_path() -> Path:
    return get_default_hermes_root() / "shared" / "lattice_auth.json"


def _read_shared_state() -> Optional[Dict[str, Any]]:
    p = _shared_store_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.debug("Failed to read shared lattice auth: %s", exc)
    return None


def _write_shared_state(state: Dict[str, Any]) -> None:
    p = _shared_store_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.debug("Failed to write shared lattice auth: %s", exc)


def _save_lattice_state(state: Dict[str, Any], carries_inference: bool = True) -> None:
    from hermes_cli.auth import _load_auth_store, _save_auth_store, _store_provider_state
    auth_store = _load_auth_store()
    _store_provider_state(auth_store, LATTICE_PROVIDER, state, set_active=carries_inference)
    _save_auth_store(auth_store)
    if is_lattice_guest_state(state):
        _write_shared_state(state)


def probe_first_valid_new_api_token(
    client: httpx.Client,
    portal_base_url: str,
    auth_headers: Dict[str, str],
    base_v1: str,
) -> tuple[str, list[str], str]:
    """Probe existing tokens in New API, testing against /v1/models.

    Returns (active_key, ordered_models, default_model).
    Raises AuthError if no tokens exist or all existing tokens are invalid/unavailable.
    Does NOT auto-create a token.
    """
    base = portal_base_url.rstrip("/")
    token_url = f"{base}/api/token/?p=0&size=50"
    resp_tokens = client.get(token_url, headers=auth_headers)
    tokens_list = []
    if resp_tokens.is_success:
        t_data = resp_tokens.json() or {}
        raw = t_data.get("data")
        if isinstance(raw, list):
            tokens_list = raw
        elif isinstance(raw, dict):
            if isinstance(raw.get("data"), list):
                tokens_list = raw["data"]
            elif isinstance(raw.get("items"), list):
                tokens_list = raw["items"]

    if not tokens_list:
        raise AuthError("该账户没有有效token，无可用模型", code="no_api_token")

    candidates_to_test: list[str] = []
    masked_ids: list[Any] = []
    for t in tokens_list:
        if isinstance(t, dict) and t.get("status") == 1:
            key_val = str(t.get("key") or "").strip()
            t_id = t.get("id")
            if key_val and "*" not in key_val and len(key_val) > 10:
                candidates_to_test.append(key_val)
            elif t_id is not None:
                masked_ids.append(t_id)

    if masked_ids:
        try:
            batch_url = f"{base}/api/token/batch/keys"
            batch_resp = client.post(batch_url, headers=auth_headers, json={"ids": masked_ids}, timeout=5.0)
            if batch_resp.is_success:
                b_data = batch_resp.json() or {}
                keys_dict = (b_data.get("data") or {}).get("keys") or {}
                if isinstance(keys_dict, dict):
                    for k in keys_dict.values():
                        if isinstance(k, str) and k and "*" not in k:
                            candidates_to_test.append(k.strip())
        except Exception as b_exc:
            logger.debug("Failed to query /api/token/batch/keys: %s", b_exc)

    if not candidates_to_test:
        raise AuthError("当前token不可用，无可用模型，检查new api账户是否创建了有效token", code="no_valid_token")

    def _test_key(raw_k: str) -> tuple[Optional[str], list[str]]:
        if not raw_k or "*" in raw_k:
            return None, []
        cand = raw_k.strip()
        variations = []
        if cand.startswith("sk-"):
            variations = [cand, cand[3:]]
        else:
            variations = [f"sk-{cand}", cand]
        for c in variations:
            if not c or "*" in c:
                continue
            endpoints = []
            if base_v1 != base:
                endpoints.append(f"{base_v1}/models")
            endpoints.append(f"{base}/models")
            for ep in endpoints:
                try:
                    test_resp = client.get(
                        ep,
                        headers={"Authorization": f"Bearer {c}", "Accept": "application/json", "User-Agent": "hermes-agent"},
                        timeout=3.5,
                    )
                    if test_resp.is_success:
                        t_json = test_resp.json() or {}
                        raw_models = t_json.get("data") or t_json.get("models") or []
                        if isinstance(raw_models, dict):
                            raw_models = raw_models.get("items") or raw_models.get("data") or []
                        cand_models = [
                            str(m["id"]) if isinstance(m, dict) and "id" in m else str(m)
                            for m in raw_models
                            if (isinstance(m, dict) and m.get("id")) or (isinstance(m, str) and m)
                        ]
                        if cand_models:
                            return c, cand_models
                except Exception:
                    pass
        return None, []

    active_key = None
    found_models: list[str] = []
    for cand in candidates_to_test:
        valid_key, cand_models = _test_key(cand)
        if valid_key and cand_models:
            active_key = valid_key
            found_models = cand_models
            break

    if not active_key or not found_models:
        raise AuthError("当前token不可用，无可用模型，检查new api账户是否创建了有效token", code="no_valid_token")

    target = "qwen3.8-27b-5090"
    if target in found_models:
        default_model = target
        ordered_models = [target] + [m for m in found_models if m != target]
    else:
        default_model = found_models[0]
        ordered_models = found_models

    return active_key, ordered_models, default_model


def refresh_lattice_token(state: Optional[Dict[str, Any]] = None, *, force: bool = False) -> Dict[str, Any]:
    """Periodically refresh the first valid token from New API.

    If existing tokens are all unavailable, does NOT create a token, but raises:
    '当前token不可用，无可用模型，检查new api账户是否创建了有效token'.
    """
    if state is None:
        state = current_lattice_state()
    if not state or (state.get("auth_method") != "password" and not state.get("logged_in")):
        return state or {}

    now = time.time()
    last_refreshed = float(state.get("token_refreshed_at") or 0)
    current_key = str(state.get("api_key") or "").strip()

    if not force and current_key and "*" not in current_key and (now - last_refreshed < LATTICE_TOKEN_REFRESH_INTERVAL_SECONDS):
        return state

    portal_url = _portal_url()
    inference_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
    base_v1 = inference_url if inference_url.endswith("/v1") else f"{inference_url}/v1"
    access_token = state.get("access_token") or (state.get("user_info") or {}).get("access_token")
    username = state.get("username", "")
    password = state.get("password", "")

    with httpx.Client(timeout=10.0) as client:
        auth_headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "hermes-agent",
        }
        if access_token:
            token_str = str(access_token).strip()
            auth_headers["Authorization"] = token_str if token_str.startswith("Bearer ") else f"Bearer {token_str}"

        re_login_needed = not access_token
        if not re_login_needed:
            try:
                t_probe = client.get(f"{portal_url}/api/token/?p=0&size=5", headers=auth_headers)
                if t_probe.status_code == 401:
                    re_login_needed = True
            except Exception:
                pass

        if re_login_needed and username and password:
            try:
                login_resp = client.post(
                    f"{portal_url}/api/user/login",
                    headers={"Accept": "application/json", "User-Agent": "hermes-agent"},
                    json={"username": username, "password": password},
                )
                if login_resp.is_success:
                    b_data = (login_resp.json() or {}).get("data") or {}
                    access_token = b_data.get("access_token") or b_data.get("token")
                    if access_token:
                        state["access_token"] = access_token
                        state["user_info"] = b_data
                        token_str = str(access_token).strip()
                        auth_headers["Authorization"] = token_str if token_str.startswith("Bearer ") else f"Bearer {token_str}"
            except Exception as login_exc:
                logger.debug("Failed to re-login during token refresh: %s", login_exc)

        try:
            active_key, ordered_models, default_model = probe_first_valid_new_api_token(
                client, portal_url, auth_headers, base_v1
            )
            state["api_key"] = active_key
            state["allowed_models"] = ordered_models
            state["default_model"] = default_model
            state["token_refreshed_at"] = now
            state.pop("token_error", None)
            _save_lattice_state(state, carries_inference=False)
            logger.info("Refreshed first valid New API token: %s... (default model: %s)", active_key[:6], default_model)
        except AuthError as auth_err:
            state["token_error"] = str(auth_err)
            _save_lattice_state(state, carries_inference=False)
            logger.warning("Token refresh warning: %s", auth_err)
            raise

    return state


def sync_lattice_models_from_server(*, timeout_seconds: float = 5.0) -> list[str]:
    """Fetch available models from server or New API, updating state cache."""
    state = current_lattice_state()
    if state and (state.get("auth_method") == "password" or state.get("logged_in")):
        try:
            with httpx.Client(timeout=timeout_seconds) as client:
                api_key = str(state.get("api_key") or "")
                base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
                models = []
                if api_key and "*" not in api_key:
                    headers = {
                        "Accept": "application/json",
                        "Authorization": f"Bearer {api_key}",
                        "User-Agent": "hermes-agent",
                    }
                    try:
                        base_v1 = base_url if base_url.endswith("/v1") else f"{base_url}/v1"
                        resp = client.get(f"{base_v1}/models", headers=headers)
                        if resp.status_code == 404:
                            resp = client.get(f"{base_url}/models", headers=headers)
                        if resp.is_success:
                            t_json = resp.json() or {}
                            raw_models = t_json.get("data") or t_json.get("models") or []
                            if isinstance(raw_models, dict):
                                raw_models = raw_models.get("items") or raw_models.get("data") or []
                            models = [
                                str(m["id"]) if isinstance(m, dict) and "id" in m else str(m)
                                for m in raw_models
                                if (isinstance(m, dict) and m.get("id")) or (isinstance(m, str) and m)
                            ]
                    except Exception as m_exc:
                        logger.debug("Failed to query /v1/models with token: %s", m_exc)
                if not models:
                    try:
                        refreshed_state = refresh_lattice_token(state, force=True)
                        models = refreshed_state.get("allowed_models") or []
                    except Exception as r_exc:
                        logger.debug("Refresh token during sync_lattice_models failed: %s", r_exc)
                if models:
                    target = "qwen3.8-27b-5090"
                    if target in models:
                        state["default_model"] = target
                        ordered_models = [target] + [m for m in models if m != target]
                    else:
                        if state.get("default_model") not in models:
                            state["default_model"] = models[0]
                        ordered_models = models
                    state["allowed_models"] = ordered_models
                    _save_lattice_state(state, carries_inference=False)
                    return ordered_models
        except Exception as exc:
            logger.debug("Failed to sync models for password state: %s", exc)
        return sorted(list(get_lattice_allowed_models()))


    if not state or not is_lattice_guest_state(state):
        state = ensure_lattice_identity(explicit=True, carries_inference=True)
    if not state:
        return sorted(list(DEFAULT_LATTICE_ALLOWED_MODELS))

    access_token = str(state.get("access_token", ""))
    base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
    if not access_token:
        return sorted(list(DEFAULT_LATTICE_ALLOWED_MODELS))

    url = f"{base_url}/models"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "hermes-agent",
    }
    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            resp = client.get(url, headers=headers)
            if resp.is_success:
                data = resp.json() or {}
                raw_models = data.get("data") or data.get("models") or []
                model_ids = []
                for m in raw_models:
                    if isinstance(m, dict) and "id" in m:
                        model_ids.append(str(m["id"]))
                    elif isinstance(m, str):
                        model_ids.append(m)
                if model_ids:
                    state["allowed_models"] = model_ids
                    if state.get("default_model") not in model_ids:
                        state["default_model"] = model_ids[0]
                    _save_lattice_state(state, carries_inference=False)
                    return sorted(model_ids)
    except Exception as exc:
        logger.debug("Failed to fetch lattice models from %s: %s", url, exc)

    return sorted(list(get_lattice_allowed_models()))


def ensure_lattice_identity(
    *, explicit: bool = True, timeout_seconds: float = LATTICE_MINT_TIMEOUT_SECONDS,
    carries_inference: bool = True, force: bool = False,
) -> Optional[Dict[str, Any]]:
    """Ensure this profile has a valid LatticeCode guest identity; adopt shared state or mint."""
    if not lattice_guest_enabled():
        return None
    failure = _mint_failure_for_profile()
    if failure and not force and not current_lattice_state() and time.monotonic() < failure.not_before:
        return None

    state = current_lattice_state()
    if state and is_lattice_guest_state(state) and state.get("anon_token"):
        return state

    portal_url = _portal_url()
    try:
        shared = _read_shared_state()
        if shared and is_lattice_guest_state(shared) and shared.get("anon_token"):
            state = dict(shared)
        else:
            with httpx.Client(timeout=timeout_seconds) as client:
                minted = mint_lattice_guest(client, portal_url)
                token = minted["token"]
                exchanged = exchange_lattice_jwt(client, portal_url, token)
                now = datetime.now(timezone.utc)
                expires_in = int(exchanged.get("expires_in") or 3600)
                expires_at = now + timedelta(seconds=expires_in)
                allowed_models = exchanged.get("allowed_models")
                if not isinstance(allowed_models, list) or not allowed_models:
                    allowed_models = list(DEFAULT_LATTICE_ALLOWED_MODELS)
                default_model = exchanged.get("default_model") or DEFAULT_LATTICE_MODEL
                state = {
                    "auth_method": LATTICE_AUTH_METHOD,
                    "anon_token": token,
                    "access_token": exchanged["access_token"],
                    "expires_at": expires_at.isoformat(),
                    "expires_in": expires_in,
                    "inference_base_url": exchanged.get("inference_base_url") or _inference_url(),
                    "device_id": minted.get("device_id", ""),
                    "allowed_models": allowed_models,
                    "default_model": default_model,
                }
                _write_shared_state(state)

        # Persist to local auth.json and shared storage
        _save_lattice_state(state, carries_inference=carries_inference)
        _clear_mint_failure()
        return state
    except Exception as exc:
        code = getattr(exc, "code", LATTICE_SERVER_ERROR)
        retry_after = getattr(exc, "retry_after", 30.0)
        _note_mint_failure(code, str(exc), retryable=code not in LATTICE_TERMINAL_CODES, retry_after=retry_after)
        logger.info("LatticeCode free tier bootstrap failed (%s): %s", code, exc)
        return None


def resolve_lattice_runtime_credentials(force_refresh: bool = False) -> Dict[str, Any]:
    """Return {'api_key': token, 'base_url': url} with automatic JWT refresh or user API key."""
    state = current_lattice_state()
    if state and (state.get("auth_method") == "password" or state.get("logged_in")):
        key = str(state.get("api_key") or "").strip()
        base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
        last_refreshed = float(state.get("token_refreshed_at") or 0)
        now = time.time()
        needs_refresh = force_refresh or ("*" in key) or not key or (now - last_refreshed >= LATTICE_TOKEN_REFRESH_INTERVAL_SECONDS)
        if needs_refresh:
            try:
                state = refresh_lattice_token(state, force=force_refresh)
                key = str(state.get("api_key") or "").strip()
            except AuthError as exc:
                logger.warning("Periodic token refresh failed: %s", exc)
                if not key or "*" in key:
                    raise
            except Exception as exc:
                logger.debug("Periodic token refresh error: %s", exc)
        return {"api_key": key, "base_url": base_url}

    if not state or not is_lattice_guest_state(state):
        state = ensure_lattice_identity(explicit=True, carries_inference=True)
        if not state:
            return {"api_key": "", "base_url": _inference_url()}

    anon_token = str(state.get("anon_token", ""))
    access_token = str(state.get("access_token", ""))
    base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
    expires_at_str = str(state.get("expires_at", ""))

    needs_refresh = force_refresh
    if expires_at_str and not needs_refresh:
        try:
            exp_dt = datetime.fromisoformat(expires_at_str)
            now = datetime.now(timezone.utc)
            if (exp_dt - now).total_seconds() < 300:  # refresh 5m before expiry
                needs_refresh = True
        except Exception:
            needs_refresh = True

    if needs_refresh and anon_token:
        try:
            with httpx.Client(timeout=LATTICE_MINT_TIMEOUT_SECONDS) as client:
                exchanged = exchange_lattice_jwt(client, _portal_url(), anon_token)
                now = datetime.now(timezone.utc)
                expires_in = int(exchanged.get("expires_in") or 3600)
                expires_at = now + timedelta(seconds=expires_in)
                state.update(
                    access_token=exchanged["access_token"],
                    expires_at=expires_at.isoformat(),
                    expires_in=expires_in,
                    inference_base_url=exchanged.get("inference_base_url") or base_url,
                )
                if "allowed_models" in exchanged and isinstance(exchanged["allowed_models"], list):
                    state["allowed_models"] = exchanged["allowed_models"]
                if "default_model" in exchanged and isinstance(exchanged["default_model"], str):
                    state["default_model"] = exchanged["default_model"]
                access_token = state["access_token"]
                base_url = state["inference_base_url"]
                _save_lattice_state(state, carries_inference=False)
        except Exception as exc:
            if getattr(exc, "code", "") == "unknown_token":
                logger.info("Lattice guest token reaped or dead; re-minting fresh guest")
                p = _shared_store_path()
                if p.exists():
                    p.unlink(missing_ok=True)
                fresh = ensure_lattice_identity(explicit=True, force=True, carries_inference=True)
                if fresh:
                    return {"api_key": fresh.get("access_token", ""), "base_url": fresh.get("inference_base_url") or base_url}
            logger.debug("Lattice JWT refresh failed, using existing token: %s", exc)

    return {"api_key": access_token, "base_url": base_url}


def fetch_new_api_models(client: httpx.Client, portal_base_url: str) -> tuple[list[str], str]:
    """Fetch available models from New API /api/pricing."""
    url = f"{portal_base_url.rstrip('/')}/api/pricing"
    try:
        resp = client.get(url, headers={"Accept": "application/json", "User-Agent": "hermes-agent"}, timeout=5.0)
        if resp.is_success:
            items = resp.json().get("data") or []
            models = [i.get("model_name") for i in items if isinstance(i, dict) and i.get("model_name")]
            if models:
                default = models[0]
                for pref in ["qwen3.8-27b-5090", "deepseek-v4.1-flash", "deepseek-v4-flash", "qwen3.8-flash", "kimi-for-coding", "qwen3.8-max"]:
                    if pref in models:
                        default = pref
                        break
                return models, default
    except Exception as exc:
        logger.debug("Failed to fetch models from New API pricing: %s", exc)
    return [], ""


def login_new_api(
    client: httpx.Client,
    portal_base_url: str,
    username: str,
    password: str,
) -> tuple[str, Dict[str, Any]]:
    """Log in to New API via /api/user/login, query /api/token, and return (api_key, user_info)."""
    base = portal_base_url.rstrip("/")
    login_url = f"{base}/api/user/login"
    headers = {"Accept": "application/json", "User-Agent": "hermes-agent"}

    resp = client.post(login_url, headers=headers, json={"username": username, "password": password})
    if resp.status_code == 401 or not resp.is_success:
        err_msg = "Invalid username or password"
        try:
            err_msg = resp.json().get("message") or err_msg
        except Exception:
            pass
        raise AuthError(f"New API login failed: {err_msg}", code="invalid_credentials")

    body = resp.json() or {}
    if not body.get("success", True):
        raise AuthError(f"New API login failed: {body.get('message', 'Login unsuccessful')}", code="invalid_credentials")

    data = body.get("data") or {}
    user_info = data if isinstance(data, dict) else {}

    access_token = None
    if isinstance(data, dict):
        access_token = data.get("access_token") or data.get("token")
        if not access_token and isinstance(data.get("user"), dict):
            access_token = data["user"].get("access_token")

    auth_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "hermes-agent",
    }
    if access_token:
        token_str = str(access_token).strip()
        auth_headers["Authorization"] = token_str if token_str.startswith("Bearer ") else f"Bearer {token_str}"

    cookie_headers = resp.headers.get_list("set-cookie")
    if cookie_headers:
        cookie_parts = [c.split(";")[0] for c in cookie_headers]
        auth_headers["Cookie"] = "; ".join(cookie_parts)
    elif client.cookies:
        auth_headers["Cookie"] = "; ".join([f"{k}={v}" for k, v in client.cookies.items()])

    base_v1 = f"{base}/v1" if not base.endswith("/v1") else base

    active_key, ordered_models, default_model = probe_first_valid_new_api_token(
        client, portal_base_url, auth_headers, base_v1
    )

    user_info["access_token"] = access_token
    user_info["models"] = ordered_models
    user_info["default_model"] = default_model
    user_info["password"] = password

    return active_key, user_info


def lattice_auth_handler(action: str, args: Any) -> bool:
    """Handle `hermes auth add|login|status|logout latticecode`."""
    if action in ("add", "login"):
        return _handle_lattice_login(args)
    elif action == "logout":
        return _handle_lattice_logout(args)
    elif action == "status":
        return _handle_lattice_status(args)
    elif action == "refresh":
        return True
    return False


def _handle_lattice_login(args: Any) -> bool:
    api_key = getattr(args, "api_key", None) or getattr(args, "token", None)
    portal_url = _portal_url()

    password = ""
    if not api_key:
        import getpass
        print(f"\n--- LatticeCode (New API) Login [{portal_url}] ---")
        try:
            username = input("Username / Email: ").strip()
            if not username:
                print("Login cancelled.")
                return True
            password = getpass.getpass("Password: ")
            if not password:
                print("Login cancelled.")
                return True
        except (KeyboardInterrupt, EOFError):
            print("\nLogin cancelled.")
            return True

        with httpx.Client(timeout=15.0) as client:
            try:
                api_key, user_info = login_new_api(client, portal_url, username, password)
            except AuthError as exc:
                print(f"\n登录失败: {exc}")
                return False
    else:
        username = "api_key_user"
        user_info = {}

    models = user_info.get("models") or []
    default_model = user_info.get("default_model") or (models[0] if models else "")
    if not models and api_key:
        with httpx.Client(timeout=5.0) as client:
            try:
                test_resp = client.get(f"{_inference_url()}/models", headers={"Authorization": f"Bearer {api_key}"})
                if test_resp.is_success:
                    raw = test_resp.json().get("data") or []
                    models = [
                        m["id"] if isinstance(m, dict) and "id" in m else str(m)
                        for m in raw
                        if (isinstance(m, dict) and m.get("id")) or (isinstance(m, str) and m)
                    ]
            except Exception:
                pass
        if not models:
            print("\n登录失败: 当前token不可用，无可用模型，检查new api账户是否创建了有效token")
            return False
        if "qwen3.8-27b-5090" in models:
            default_model = "qwen3.8-27b-5090"
            models = ["qwen3.8-27b-5090"] + [m for m in models if m != "qwen3.8-27b-5090"]
        else:
            default_model = models[0]

    state = {
        "auth_method": "password",
        "api_key": api_key,
        "username": username,
        "password": password,
        "user_info": user_info,
        "access_token": user_info.get("access_token"),
        "inference_base_url": _inference_url(),
        "allowed_models": models,
        "default_model": default_model,
        "token_refreshed_at": time.time(),
        "logged_in": True,
    }
    _save_lattice_state(state, carries_inference=True)

    from hermes_cli.config import set_config_value
    set_config_value("model.provider", LATTICE_PROVIDER)
    if default_model:
        set_config_value("model.default", default_model)
    set_config_value("model.base_url", _inference_url())

    mask = f"{api_key[:6]}...{api_key[-4:]}" if len(api_key) > 10 else "***"
    print(f"\nLogin successful! Configured API key: {mask}")
    print(f"Default model set to {default_model}.")
    print("Active provider set to latticecode.")
    return True


def _handle_lattice_logout(args: Any) -> bool:
    logout_lattice()
    print("Logged out from LatticeCode / New API account.")
    return True


def logout_lattice() -> bool:
    """Log out of LatticeCode / New API account, clear credentials, and reset config."""
    from hermes_cli.auth import _load_auth_store, _save_auth_store, _auth_store_lock
    try:
        with _auth_store_lock():
            auth_store = _load_auth_store()
            providers = auth_store.get("providers", {})
            if LATTICE_PROVIDER in providers:
                providers.pop(LATTICE_PROVIDER, None)
            if auth_store.get("active_provider") == LATTICE_PROVIDER:
                auth_store["active_provider"] = None
            _save_auth_store(auth_store)
    except Exception as exc:
        logger.warning("Failed to clear lattice auth store: %s", exc)

    if lattice_guest_enabled():
        shared = _read_shared_state()
        if shared and is_lattice_guest_state(shared) and shared.get("anon_token"):
            _save_lattice_state(dict(shared), carries_inference=False)

    try:
        from hermes_cli.config import load_config_readonly, set_config_value
        cfg = load_config_readonly() or {}
        model_cfg = cfg.get("model") or {}
        if model_cfg.get("provider") == LATTICE_PROVIDER:
            set_config_value("model.provider", "")
            set_config_value("model.default", "")
            set_config_value("model.base_url", "")
    except Exception as exc:
        logger.warning("Failed to reset config after lattice logout: %s", exc)

    return True


def _handle_lattice_status(args: Any) -> bool:
    state = current_lattice_state()
    if not state:
        print("LatticeCode: Not configured (will mint anonymous guest on first turn).")
        return True
    if state.get("auth_method") == "password":
        key = state.get("api_key", "")
        masked = f"{key[:6]}...{key[-4:]}" if len(key) > 10 else "(configured)"
        print(f"LatticeCode: Logged in as {state.get('username')}")
        print(f"  Auth Method: Password / New API Token")
        print(f"  API Key:     {masked}")
        print(f"  Endpoint:    {state.get('inference_base_url') or _inference_url()}")
    elif is_lattice_guest_state(state):
        print("LatticeCode: Connected via Anonymous Free Tier")
        print(f"  Device Token: {str(state.get('anon_token', ''))[:12]}...")
        print(f"  Expires At:   {state.get('expires_at', 'unknown')}")
        print(f"  Endpoint:     {state.get('inference_base_url') or _inference_url()}")
    return True
