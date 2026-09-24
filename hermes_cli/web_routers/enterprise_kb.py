"""Enterprise Knowledge Base (RAGFlow) dashboard router."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hermes_cli.auth_ragflow import (
    RAGFLOW_DEFAULT_PASSWORD,
    RAGFLOW_DEFAULT_URL,
    RAGFLOW_DEFAULT_USERNAME,
    clear_ragflow_auth_state,
    fetch_ragflow_datasets,
    get_ragflow_auth_state,
    get_session_active_datasets,
    is_ragflow_logged_in,
    login_ragflow,
    set_session_active_datasets,
)
from hermes_cli.web_routers._common import log

router = APIRouter(prefix="/api/enterprise-kb", tags=["enterprise-kb"])


class LoginRequest(BaseModel):
    username: str = Field(default=RAGFLOW_DEFAULT_USERNAME, description="Knowledge base username or email")
    password: str = Field(default=RAGFLOW_DEFAULT_PASSWORD, description="Knowledge base password")
    base_url: str = Field(default=RAGFLOW_DEFAULT_URL, description="RAGFlow service URL")


class SessionDatasetsRequest(BaseModel):
    session_id: str = Field(..., description="Hermes session ID")
    dataset_ids: List[str] = Field(default_factory=list, description="Selected dataset IDs")


@router.post("/login")
async def api_enterprise_kb_login(req: LoginRequest):
    """Log in to the enterprise knowledge base (RAGFlow)."""
    try:
        state = login_ragflow(
            username=req.username,
            password=req.password,
            base_url=req.base_url,
        )
        u = state.get("username")
        display_username = "默认账户" if (not u or u == RAGFLOW_DEFAULT_USERNAME) else u
        return {
            "success": True,
            "username": display_username,
            "base_url": state.get("base_url"),
            "datasets": state.get("cached_datasets", []),
        }
    except Exception as exc:
        log.warning("Enterprise KB login API failed: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/status")
async def api_enterprise_kb_status():
    """Check enterprise knowledge base authentication status."""
    logged_in = is_ragflow_logged_in()
    state = get_ragflow_auth_state() or {}
    username = state.get("username")
    display_username = "默认账户" if (not username or username == RAGFLOW_DEFAULT_USERNAME) else username
    return {
        "logged_in": logged_in,
        "username": display_username,
        "base_url": state.get("base_url") or RAGFLOW_DEFAULT_URL,
        "datasets": state.get("cached_datasets", []),
        "logged_in_at": state.get("logged_in_at"),
    }


@router.get("/datasets")
async def api_enterprise_kb_datasets():
    """Fetch the latest datasets from RAGFlow."""
    if not is_ragflow_logged_in():
        raise HTTPException(status_code=401, detail="Enterprise knowledge base is not logged in.")
    try:
        datasets = fetch_ragflow_datasets()
        return {"datasets": datasets}
    except Exception as exc:
        log.warning("Enterprise KB dataset fetch API failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/logout")
async def api_enterprise_kb_logout():
    """Log out from the enterprise knowledge base."""
    clear_ragflow_auth_state()
    return {"success": True}


@router.post("/session-datasets")
async def api_set_session_datasets(req: SessionDatasetsRequest):
    """Set the active knowledge bases for a conversation session."""
    set_session_active_datasets(req.session_id, req.dataset_ids)
    return {
        "success": True,
        "session_id": req.session_id,
        "dataset_ids": req.dataset_ids,
    }


@router.get("/session-datasets")
async def api_get_session_datasets(session_id: str = Query(..., description="Hermes session ID")):
    """Get the active knowledge bases for a conversation session."""
    ids = get_session_active_datasets(session_id)
    return {
        "session_id": session_id,
        "dataset_ids": ids,
    }
