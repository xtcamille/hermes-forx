"""RAGFlow enterprise knowledge base authentication and retrieval client."""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from hermes_cli.auth_constants import AuthError, httpx
from hermes_constants import get_hermes_home

logger = logging.getLogger("hermes_cli.auth_ragflow")

RAGFLOW_DEFAULT_URL = "http://172.22.0.87"
RAGFLOW_AUTH_PROVIDER = "enterprise_kb"

# RAGFlow frontend RSA public key for password encryption
RAGFLOW_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArq9XTUSeYr2+N1h3Afl/z8Dse/2yD0ZGrKwx+EEEcdsBLca9Ynmx3nIB5obmLlSfmskLpBo0UACBmB5rEjBp2Q2f3AG3Hjd4B+gNCG6BDaawuDlgANIhGnaTLrIqWrrcm4EMzJOnAOI1fgzJRsOOUEfaS318Eq9OVO3apEyCCt0lOQK6PuksduOjVxtltDav+guVAA068NrPYmRNabVKRNLJpL8w4D44sfth5RvZ3q9t+6RTArpEtc5sh5ChzvqPOzKGMXW83C95TxmXqpbK6olN4RevSfVjEAgCydH6HN6OhtOQEcnrU97r9H0iZOWwbw3pVrZiUkuRD1R56Wzs2wIDAQAB
-----END PUBLIC KEY-----"""

# Session-scoped active datasets mapping: session_id -> list of dataset_ids
_session_datasets: Dict[str, List[str]] = {}


def encrypt_ragflow_password(password: str) -> str:
    """Encrypt password using RAGFlow RSA public key (base64 of PKCS1-v1_5 encrypted base64 password)."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        pubkey = serialization.load_pem_public_key(RAGFLOW_PUBLIC_KEY.encode("utf-8"))
        b64_pwd = base64.b64encode(password.encode("utf-8"))
        encrypted = pubkey.encrypt(b64_pwd, padding.PKCS1v15())
        return base64.b64encode(encrypted).decode("ascii")
    except Exception as exc:
        logger.warning("Failed to encrypt password with RAGFlow RSA key: %s", exc)
        return password


def normalize_ragflow_url(url: Optional[str]) -> str:
    """Normalize RAGFlow base URL (strip trailing slashes, /login, etc.)."""
    raw = (url or RAGFLOW_DEFAULT_URL).strip().rstrip("/")
    if raw.endswith("/login"):
        raw = raw[:-6].rstrip("/")
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "http://" + raw
    return raw


def get_ragflow_auth_state() -> Optional[Dict[str, Any]]:
    """Return the currently stored enterprise knowledge base auth state, or None."""
    try:
        from hermes_cli.auth import get_provider_auth_state
        state = get_provider_auth_state(RAGFLOW_AUTH_PROVIDER)
        if isinstance(state, dict) and (state.get("access_token") or state.get("token")):
            return state
    except Exception as exc:
        logger.debug("Failed to read enterprise_kb auth state: %s", exc)
    return None


def is_ragflow_logged_in() -> bool:
    """Check if the enterprise knowledge base is currently authenticated."""
    state = get_ragflow_auth_state()
    return bool(state and (state.get("access_token") or state.get("token")))


def save_ragflow_auth_state(state: Dict[str, Any]) -> None:
    """Persist enterprise knowledge base auth state to auth.json."""
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store, _store_section
    with _auth_store_lock():
        store = _load_auth_store()
        providers = _store_section(store, "providers")
        providers[RAGFLOW_AUTH_PROVIDER] = state
        _save_auth_store(store)


def clear_ragflow_auth_state() -> None:
    """Clear enterprise knowledge base credentials from auth.json."""
    from hermes_cli.auth import _auth_store_lock, _load_auth_store, _save_auth_store
    with _auth_store_lock():
        store = _load_auth_store()
        providers = store.get("providers", {})
        if RAGFLOW_AUTH_PROVIDER in providers:
            providers.pop(RAGFLOW_AUTH_PROVIDER, None)
            _save_auth_store(store)


def set_session_active_datasets(session_id: str, dataset_ids: List[str]) -> None:
    """Bind selected dataset IDs to a specific conversation session."""
    if session_id:
        _session_datasets[session_id] = list(dataset_ids or [])


def get_session_active_datasets(session_id: Optional[str]) -> List[str]:
    """Get selected dataset IDs for a specific conversation session."""
    if session_id and session_id in _session_datasets:
        return list(_session_datasets[session_id])
    state = get_ragflow_auth_state()
    if state:
        if isinstance(state.get("default_dataset_ids"), list):
            return list(state["default_dataset_ids"])
        # If no explicit subset is defined, default to all accessible cached datasets
        if state.get("cached_datasets"):
            return [str(d["id"]) for d in state["cached_datasets"] if isinstance(d, dict) and "id" in d]
    return []


def login_ragflow(
    username: str,
    password: str,
    base_url: str = RAGFLOW_DEFAULT_URL,
    client: Optional[httpx.Client] = None,
    timeout_seconds: float = 15.0,
) -> Dict[str, Any]:
    """Authenticate with RAGFlow via /api/v1/auth/login with RSA encrypted password."""
    clean_url = normalize_ragflow_url(base_url)
    headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "hermes-agent"}

    enc_password = encrypt_ragflow_password(password)

    candidate_endpoints = [
        f"{clean_url}/api/v1/auth/login",
        f"{clean_url}/v1/auth/login",
        f"{clean_url}/api/v1/user/login",
        f"{clean_url}/v1/user/login",
        f"{clean_url}/api/v1/login",
    ]

    payloads = [
        {"email": username, "password": enc_password},
        {"email": username, "password": password},
        {"username": username, "password": enc_password},
        {"username": username, "password": password},
    ]

    last_error: Optional[str] = None
    token: Optional[str] = None
    user_data: Dict[str, Any] = {}

    def _do_login(c: httpx.Client) -> tuple[Optional[str], Dict[str, Any]]:
        nonlocal last_error
        for ep in candidate_endpoints:
            for pl in payloads:
                try:
                    resp = c.post(ep, headers=headers, json=pl)
                    if resp.status_code == 404:
                        continue
                    data = resp.json() if resp.content else {}

                    code = data.get("code", data.get("retcode"))
                    if code == 0 or (resp.is_success and "data" in data and code is None):
                        inner = data.get("data") or {}
                        tok = (
                            (inner.get("access_token") if isinstance(inner, dict) else None)
                            or (inner.get("token") if isinstance(inner, dict) else None)
                            or (inner.get("auth_token") if isinstance(inner, dict) else None)
                            or resp.headers.get("Authorization", "").replace("Bearer ", "").strip()
                            or resp.cookies.get("token")
                        )
                        if tok:
                            return str(tok), inner if isinstance(inner, dict) else {}
                    err_msg = data.get("message") or data.get("retmsg") or (resp.text if not resp.is_success else None)
                    if err_msg:
                        last_error = str(err_msg)
                    if code is not None and code != 0:
                        # RAGFlow explicitly recognized the endpoint and returned a business rejection
                        break
                except Exception as exc:
                    last_error = str(exc)
        return None, {}

    if client is not None:
        token, user_data = _do_login(client)
    else:
        with httpx.Client(timeout=timeout_seconds) as c:
            token, user_data = _do_login(c)

    if not token:
        raise AuthError(
            f"Failed to log in to enterprise knowledge base at {clean_url}: {last_error or 'Invalid credentials or service unreachable'}",
            code="ragflow_login_failed"
        )

    # Now fetch the user's accessible datasets
    datasets: List[Dict[str, Any]] = []
    try:
        datasets = fetch_ragflow_datasets(clean_url, token, client=client)
    except Exception as exc:
        logger.warning("RAGFlow logged in successfully, but dataset fetch had issue: %s", exc)

    state = {
        "base_url": clean_url,
        "username": username,
        "access_token": token,
        "user_info": user_data,
        "cached_datasets": datasets,
        "logged_in_at": datetime.now(timezone.utc).isoformat(),
    }
    save_ragflow_auth_state(state)
    logger.info("Enterprise knowledge base login succeeded for %s with %d datasets", username, len(datasets))
    return state


def fetch_ragflow_datasets(
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    client: Optional[httpx.Client] = None,
    timeout_seconds: float = 15.0,
) -> List[Dict[str, Any]]:
    """Fetch all knowledge bases / datasets accessible by the authenticated account."""
    if not base_url or not token:
        state = get_ragflow_auth_state()
        if not state or not (state.get("access_token") or state.get("token")):
            raise AuthError("Enterprise knowledge base is not logged in.", code="not_authenticated")
        base_url = state.get("base_url") or RAGFLOW_DEFAULT_URL
        token = state.get("access_token") or state.get("token")

    clean_url = normalize_ragflow_url(base_url)
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "Token": token,
        "User-Agent": "hermes-agent",
    }
    candidate_endpoints = [
        f"{clean_url}/api/v1/datasets?page=1&page_size=100",
        f"{clean_url}/api/v1/datasets",
        f"{clean_url}/v1/dataset?page=1&page_size=100",
        f"{clean_url}/api/v1/dataset",
    ]

    datasets: List[Dict[str, Any]] = []

    def _fetch(c: httpx.Client) -> List[Dict[str, Any]]:
        for ep in candidate_endpoints:
            try:
                resp = c.get(ep, headers=headers)
                if resp.status_code == 404:
                    continue
                data = resp.json() if resp.content else {}
                code = data.get("code", data.get("retcode"))
                if code == 0 or (resp.is_success and "data" in data and code is None):
                    raw_list = data.get("data")
                    if isinstance(raw_list, dict) and "datasets" in raw_list:
                        raw_list = raw_list["datasets"]
                    elif isinstance(raw_list, dict) and "items" in raw_list:
                        raw_list = raw_list["items"]
                    elif not isinstance(raw_list, list):
                        raw_list = []

                    parsed = []
                    for item in raw_list:
                        if isinstance(item, dict) and "id" in item:
                            parsed.append({
                                "id": str(item["id"]),
                                "name": str(item.get("name") or item["id"]),
                                "document_count": int(item.get("document_count", item.get("doc_count", 0))),
                                "description": str(item.get("description", "")),
                                "permission": str(item.get("permission", "me")),
                                "avatar": str(item.get("avatar", "")),
                            })
                    return parsed
            except Exception as exc:
                logger.debug("Failed fetching datasets from %s: %s", ep, exc)
        return []

    if client is not None:
        datasets = _fetch(client)
    else:
        with httpx.Client(timeout=timeout_seconds) as c:
            datasets = _fetch(c)

    # Refresh cached datasets in state
    state = get_ragflow_auth_state()
    if state and datasets:
        state["cached_datasets"] = datasets
        save_ragflow_auth_state(state)

    return datasets


def search_ragflow(
    query: str,
    dataset_ids: Optional[List[str]] = None,
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    top_k: int = 6,
    similarity_threshold: float = 0.2,
    vector_similarity_weight: float = 0.7,
    client: Optional[httpx.Client] = None,
    timeout_seconds: float = 30.0,
) -> List[Dict[str, Any]]:
    """Search documents in the specified enterprise datasets via RAGFlow retrieval API."""
    if not base_url or not token:
        state = get_ragflow_auth_state()
        if not state or not (state.get("access_token") or state.get("token")):
            raise AuthError("Enterprise knowledge base is not logged in.", code="not_authenticated")
        base_url = state.get("base_url") or RAGFLOW_DEFAULT_URL
        token = state.get("access_token") or state.get("token")

    clean_url = normalize_ragflow_url(base_url)
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Token": token,
        "User-Agent": "hermes-agent",
    }
    candidate_endpoints = [
        f"{clean_url}/api/v1/datasets/search",
        f"{clean_url}/api/v1/retrieval",
        f"{clean_url}/v1/api/retrieval",
    ]
    if not dataset_ids:
        dataset_ids = get_session_active_datasets(None)
    if not dataset_ids and state and state.get("cached_datasets"):
        dataset_ids = [str(d["id"]) for d in state["cached_datasets"] if isinstance(d, dict) and "id" in d]

    payload = {
        "question": query,
        "dataset_ids": dataset_ids or [],
        "top_k": top_k,
        "similarity_threshold": similarity_threshold,
        "vector_similarity_weight": vector_similarity_weight,
    }

    def _search(c: httpx.Client) -> List[Dict[str, Any]]:
        for ep in candidate_endpoints:
            try:
                resp = c.post(ep, headers=headers, json=payload)
                if resp.status_code == 404:
                    continue
                data = resp.json() if resp.content else {}
                code = data.get("code", data.get("retcode"))
                if code == 0 or (resp.is_success and "data" in data and code is None):
                    raw_chunks = (data.get("data") or {}).get("chunks") or []
                    results = []
                    for c_item in raw_chunks:
                        if isinstance(c_item, dict):
                            results.append({
                                "content": str(c_item.get("content_with_weight") or c_item.get("content", "")),
                                "document_name": str(c_item.get("document_name") or c_item.get("docnm_kwd", "未知文档")),
                                "dataset_id": str(c_item.get("dataset_id", "")),
                                "similarity": float(c_item.get("similarity", 0.0)),
                            })
                    return results
            except Exception as exc:
                logger.debug("Failed searching from %s: %s", ep, exc)
        return []

    if client is not None:
        return _search(client)
    else:
        with httpx.Client(timeout=timeout_seconds) as c:
            return _search(c)
