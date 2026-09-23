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
    target = "qwen3.8-27b-5090"
    if state and isinstance(state.get("allowed_models"), (list, tuple, set, frozenset)) and state["allowed_models"]:
        raw = list(state["allowed_models"])
        if target in raw:
            return frozenset([target])
        match = next((m for m in raw if "5090" in m or "qwen3.8-27b" in m), None)
        if match:
            return frozenset([match])
        return frozenset(raw)
    if state and (state.get("auth_method") == "password" or state.get("logged_in")):
        try:
            synced = sync_lattice_models_from_server(timeout_seconds=3.0)
            if synced:
                if target in synced:
                    return frozenset([target])
                match = next((m for m in synced if "5090" in m or "qwen3.8-27b" in m), None)
                if match:
                    return frozenset([match])
                return frozenset(synced)
        except Exception:
            pass
    return DEFAULT_LATTICE_ALLOWED_MODELS


def get_lattice_default_model() -> str:
    """Return the default model for LatticeCode (server-synced if available, else default)."""
    state = current_lattice_state()
    if state and isinstance(state.get("default_model"), str) and state["default_model"]:
        return state["default_model"]
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


def sync_lattice_models_from_server(*, timeout_seconds: float = 5.0) -> list[str]:
    """Fetch available models from server or New API, updating state cache."""
    state = current_lattice_state()
    if state and (state.get("auth_method") == "password" or state.get("logged_in")):
        portal = _portal_url()
        try:
            with httpx.Client(timeout=timeout_seconds) as client:
                api_key = str(state.get("api_key") or state.get("access_token", ""))
                base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
                models = []
                detected_default = ""
                if api_key:
                    headers = {
                        "Accept": "application/json",
                        "Authorization": f"Bearer {api_key}",
                        "User-Agent": "hermes-agent",
                    }
                    try:
                        resp = client.get(f"{base_url}/models", headers=headers)
                        if resp.is_success:
                            raw_models = resp.json().get("data") or []
                            models = [m["id"] if isinstance(m, dict) and "id" in m else str(m) for m in raw_models]
                    except Exception as m_exc:
                        logger.debug("Failed to query /v1/models with token: %s", m_exc)
                if not models:
                    models, detected_default = fetch_new_api_models(client, portal)
                if models:
                    state["allowed_models"] = models
                    if "qwen3.8-27b-5090" in models:
                        state["default_model"] = "qwen3.8-27b-5090"
                    elif detected_default and detected_default in models:
                        state["default_model"] = detected_default
                    elif state.get("default_model") not in models:
                        state["default_model"] = models[0]
                    _save_lattice_state(state, carries_inference=False)
                    return sorted(models)
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
    if state and state.get("auth_method") == "password" and state.get("api_key"):
        key = str(state["api_key"]).strip()
        base_url = str(state.get("inference_base_url") or _inference_url()).rstrip("/")
        if "*" in key:
            # Masked key detected in state - attempt self-healing using saved JWT
            user_info = state.get("user_info") or {}
            access_token = user_info.get("access_token")
            portal_url = _portal_url()
            if access_token:
                try:
                    with httpx.Client(timeout=5.0) as client:
                        auth_hdr = {
                            "Authorization": f"Bearer {access_token}",
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                        }
                        t_resp = client.get(f"{portal_url}/api/token/?p=0&size=50", headers=auth_hdr)
                        if t_resp.is_success:
                            raw_t = t_resp.json().get("data") or {}
                            items = raw_t if isinstance(raw_t, list) else (raw_t.get("items") or raw_t.get("data") or [])
                            ids = [it["id"] for it in items if isinstance(it, dict) and it.get("status") == 1 and it.get("id")]
                            if ids:
                                b_resp = client.post(f"{portal_url}/api/token/batch/keys", headers=auth_hdr, json={"ids": ids})
                                if b_resp.is_success:
                                    keys = (b_resp.json().get("data") or {}).get("keys") or {}
                                    for k_val in keys.values():
                                        if isinstance(k_val, str) and "*" not in k_val:
                                            cand = f"sk-{k_val}" if not k_val.startswith("sk-") else k_val
                                            m_test = client.get(f"{base_url}/models", headers={"Authorization": f"Bearer {cand}"})
                                            if m_test.is_success:
                                                state["api_key"] = cand
                                                _save_lattice_state(state, carries_inference=False)
                                                logger.info("Self-healed masked New API key to active token")
                                                return {"api_key": cand, "base_url": base_url}
                except Exception as heal_exc:
                    logger.debug("Failed to self-heal masked key: %s", heal_exc)
        else:
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

    # Extract JWT/access token returned by login
    access_token = None
    if isinstance(data, dict):
        access_token = data.get("access_token") or data.get("token")
        if not access_token and isinstance(data.get("user"), dict):
            access_token = data["user"].get("access_token")

    # Build authenticated headers for subsequent New API calls
    auth_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "hermes-agent",
    }
    if access_token:
        token_str = str(access_token).strip()
        auth_headers["Authorization"] = token_str if token_str.startswith("Bearer ") else f"Bearer {token_str}"

    # Also capture cookies from response
    cookie_headers = resp.headers.get_list("set-cookie")
    if cookie_headers:
        cookie_parts = [c.split(";")[0] for c in cookie_headers]
        auth_headers["Cookie"] = "; ".join(cookie_parts)
    elif client.cookies:
        auth_headers["Cookie"] = "; ".join([f"{k}={v}" for k, v in client.cookies.items()])

    # Query tokens to find active token
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

    active_key = None
    base_v1 = f"{base}/v1" if not base.endswith("/v1") else base

    def _format_and_test_key(raw_k: str) -> Optional[str]:
        if not raw_k or "*" in raw_k:
            return None
        cand = raw_k.strip()
        variations = []
        if cand.startswith("sk-"):
            variations = [cand, cand[3:]]
        else:
            variations = [f"sk-{cand}", cand]
        for c in variations:
            if not c or "*" in c:
                continue
            try:
                test_resp = client.get(
                    f"{base_v1}/models",
                    headers={"Authorization": f"Bearer {c}"},
                    timeout=3.0,
                )
                if test_resp.is_success:
                    return c
            except Exception:
                pass
        return None

    # Step 1: Separate unmasked keys and masked token IDs
    candidates_to_test = []
    masked_ids = []
    for t in tokens_list:
        if isinstance(t, dict) and t.get("status") == 1:
            key_val = str(t.get("key") or "").strip()
            t_id = t.get("id")
            if key_val and "*" not in key_val and len(key_val) > 10:
                candidates_to_test.append(key_val)
            elif t_id is not None:
                masked_ids.append(t_id)

    # Step 2: Fetch unmasked keys via POST /api/token/batch/keys for masked tokens
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

    # Step 3: Test candidate keys against /v1/models
    for cand in candidates_to_test:
        valid_key = _format_and_test_key(cand)
        if valid_key:
            active_key = valid_key
            break

    # Step 4: If no existing active key worked, create a fresh token
    resp_create = None
    if not active_key:
        create_url = f"{base}/api/token/"
        create_payload = {
            "name": "Hermes Agent",
            "remain_quota": 500000,
            "expired_time": -1,
            "unlimited_quota": True,
        }
        try:
            resp_create = client.post(create_url, headers=auth_headers, json=create_payload, timeout=5.0)
            if resp_create.is_success:
                c_data = resp_create.json() or {}
                c_inner = c_data.get("data") or {}
                if isinstance(c_inner, dict) and c_inner.get("key"):
                    active_key = _format_and_test_key(str(c_inner["key"]))
                elif isinstance(c_inner, str) and c_inner:
                    active_key = _format_and_test_key(c_inner)

                if not active_key:
                    # Re-query token list to find newly created token ID
                    re_tokens_resp = client.get(f"{base}/api/token/?p=0&size=10", headers=auth_headers, timeout=5.0)
                    if re_tokens_resp.is_success:
                        rt_data = re_tokens_resp.json() or {}
                        raw_rt = rt_data.get("data")
                        rt_list = []
                        if isinstance(raw_rt, list):
                            rt_list = raw_rt
                        elif isinstance(raw_rt, dict):
                            rt_list = raw_rt.get("items") or raw_rt.get("data") or []
                        if rt_list and isinstance(rt_list[0], dict):
                            new_id = rt_list[0].get("id")
                            new_key_raw = str(rt_list[0].get("key") or "").strip()
                            if new_key_raw and "*" not in new_key_raw:
                                active_key = _format_and_test_key(new_key_raw)
                            elif new_id is not None:
                                b_resp = client.post(f"{base}/api/token/batch/keys", headers=auth_headers, json={"ids": [new_id]}, timeout=5.0)
                                if b_resp.is_success:
                                    b_keys = (b_resp.json().get("data") or {}).get("keys") or {}
                                    for k_val in b_keys.values():
                                        if isinstance(k_val, str) and k_val and "*" not in k_val:
                                            valid_k = _format_and_test_key(k_val)
                                            if valid_k:
                                                active_key = valid_k
                                                break
        except Exception as c_exc:
            logger.debug("Failed during token creation/unmasking: %s", c_exc)

    # Strictly disallow any masked key
    if active_key and "*" in active_key:
        active_key = None

    if not active_key:
        err_detail = ""
        if not resp_tokens.is_success:
            try:
                err_detail = f" (Query /api/token/ failed {resp_tokens.status_code}: {resp_tokens.json().get('message')})"
            except Exception:
                err_detail = f" (Query /api/token/ failed {resp_tokens.status_code})"
        elif resp_create is not None and not resp_create.is_success:
            try:
                err_detail = f" (Create /api/token/ failed {resp_create.status_code}: {resp_create.json().get('message')})"
            except Exception:
                err_detail = f" (Create /api/token/ failed {resp_create.status_code})"
        raise AuthError(f"Login succeeded, but failed to retrieve or create a valid API token from New API.{err_detail}", code="no_api_token")

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
            api_key, user_info = login_new_api(client, portal_url, username, password)
    else:
        username = "api_key_user"
        user_info = {}

    state = {
        "auth_method": "password",
        "api_key": api_key,
        "username": username,
        "user_info": user_info,
        "inference_base_url": _inference_url(),
        "logged_in": True,
    }
    _save_lattice_state(state, carries_inference=True)
    mask = f"{api_key[:6]}...{api_key[-4:]}" if len(api_key) > 10 else "***"
    print(f"\nLogin successful! Configured API key: {mask}")
    print("Active provider set to latticecode.")
    return True


def _handle_lattice_logout(args: Any) -> bool:
    from hermes_cli.auth import _load_auth_store, _save_auth_store
    auth_store = _load_auth_store()
    current = auth_store.get("providers", {}).get(LATTICE_PROVIDER)

    if current and current.get("auth_method") == "password":
        username = current.get("username", "user")
        print(f"Logged out from LatticeCode account ({username}).")
    else:
        print("Not logged in to a LatticeCode account.")

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


def _handle_lattice_logout(args: Any) -> bool:
    logout_lattice()
    print("Logged out from LatticeCode / New API account.")
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
