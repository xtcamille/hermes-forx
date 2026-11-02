"""FastAPI Backend routes for forx-context plugin."""
from __future__ import annotations

import hashlib
import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.routing import APIRoute
from pydantic import ValidationError

logger = logging.getLogger(__name__)

# Dynamically import sibling analyzer module
_root = Path(__file__).resolve().parents[1]
_name = "forx_context_" + hashlib.sha256(str(_root).encode()).hexdigest()[:16]
if _name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        _name, _root / "__init__.py", submodule_search_locations=[str(_root)]
    )
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_name] = _module
    _spec.loader.exec_module(_module)

analyzer = __import__(_name + ".analyzer", fromlist=["analyze_session_context", "get_fleet_context_overview"])


class ScopedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def scoped(request: Request):
            from hermes_cli.web_server_profiles import _config_profile_scope
            try:
                with _config_profile_scope(request.query_params.get("profile")):
                    return await handler(request)
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
            except (ValueError, ValidationError) as exc:
                raise HTTPException(422, str(exc)) from exc
            except Exception as exc:
                logger.exception("Context plugin API error: %s", exc)
                raise HTTPException(500, f"Internal server error: {exc}") from exc
        return scoped


router = APIRouter(route_class=ScopedRoute)


@router.get("/overview")
async def get_overview(
    days: int = Query(7, ge=1, le=90),
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Retrieve multi-session overview, KPI aggregates, daily trends and activity heatmap."""
    return analyzer.get_fleet_context_overview(profile=profile, days=days)


@router.get("/sessions/{session_id}")
async def get_session_detail(
    session_id: str,
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Retrieve full context breakdown, capacity, tokens, cost, segments, tools, and timeline for a session."""
    data = analyzer.analyze_session_context(session_id, profile=profile)
    if not data.get("ok"):
        raise HTTPException(404, data.get("error", f"Session '{session_id}' not found"))
    return data


@router.get("/current")
async def get_current_session(
    profile: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Retrieve context analysis for the most recently active session."""
    fleet = analyzer.get_fleet_context_overview(profile=profile, days=7)
    sessions = fleet.get("sessions", [])
    if not sessions:
        raise HTTPException(404, "No active sessions found")
    first_id = sessions[0]["id"]
    return analyzer.analyze_session_context(first_id, profile=profile)
