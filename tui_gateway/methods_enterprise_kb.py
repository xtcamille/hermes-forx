"""Enterprise Knowledge Base (RAGFlow) JSON-RPC handlers for Desktop/TUI."""

import logging

from .method_ctx import HandlerRegistry, bind_module

logger = logging.getLogger(__name__)
_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


@method("enterprise_kb.status")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Return current enterprise knowledge base authentication and cached datasets."""
    try:
        from hermes_cli.auth_ragflow import (
            RAGFLOW_DEFAULT_URL,
            get_ragflow_auth_state,
            is_ragflow_logged_in,
        )
        logged_in = is_ragflow_logged_in()
        state = get_ragflow_auth_state() or {}
        return _ok(rid, {
            "logged_in": logged_in,
            "username": state.get("username"),
            "base_url": state.get("base_url") or RAGFLOW_DEFAULT_URL,
            "datasets": state.get("cached_datasets", []),
        })
    except Exception as e:
        return _err(rid, 5091, str(e))


@method("enterprise_kb.login")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Log in to RAGFlow enterprise knowledge base."""
    try:
        from hermes_cli.auth_ragflow import RAGFLOW_DEFAULT_URL, login_ragflow
        username = params.get("username", "")
        password = params.get("password", "")
        base_url = params.get("base_url") or RAGFLOW_DEFAULT_URL
        if not username or not password:
            return _err(rid, 5092, "Username and password are required")
        state = login_ragflow(username=username, password=password, base_url=base_url)
        return _ok(rid, {
            "success": True,
            "username": state.get("username"),
            "base_url": state.get("base_url"),
            "datasets": state.get("cached_datasets", []),
        })
    except Exception as e:
        return _err(rid, 5093, str(e))


@method("enterprise_kb.datasets")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Fetch/refresh the user's accessible datasets from RAGFlow."""
    try:
        from hermes_cli.auth_ragflow import fetch_ragflow_datasets
        datasets = fetch_ragflow_datasets()
        return _ok(rid, {"datasets": datasets})
    except Exception as e:
        return _err(rid, 5094, str(e))


@method("enterprise_kb.set_session_datasets")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Set the active knowledge bases for a conversation session."""
    try:
        from hermes_cli.auth_ragflow import set_session_active_datasets
        session_id = params.get("session_id", "")
        dataset_ids = params.get("dataset_ids", [])
        set_session_active_datasets(session_id, dataset_ids)
        return _ok(rid, {"success": True, "session_id": session_id, "dataset_ids": dataset_ids})
    except Exception as e:
        return _err(rid, 5095, str(e))


@method("enterprise_kb.logout")
@_profile_scoped
def _(rid, params: dict) -> dict:
    """Log out from the enterprise knowledge base."""
    try:
        from hermes_cli.auth_ragflow import clear_ragflow_auth_state
        clear_ragflow_auth_state()
        return _ok(rid, {"success": True})
    except Exception as e:
        return _err(rid, 5096, str(e))


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
