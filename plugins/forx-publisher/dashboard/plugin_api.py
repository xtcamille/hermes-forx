"""FastAPI Backend routes for forx-publisher plugin."""
from __future__ import annotations

import hashlib
import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Dynamically import sibling publisher module
_root = Path(__file__).resolve().parents[1]
_name = "forx_publisher_" + hashlib.sha256(str(_root).encode()).hexdigest()[:16]
if _name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        _name, _root / "__init__.py", submodule_search_locations=[str(_root)]
    )
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_name] = _module
    _spec.loader.exec_module(_module)

publisher = __import__(
    _name + ".publisher",
    fromlist=[
        "check_target",
        "publish_plugin",
        "publish_skill",
        "get_auth_status",
        "save_github_token",
        "clear_github_token",
        "DEFAULT_TARGET_REPO",
    ],
)


class ScopedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def scoped(request: Request):
            from hermes_cli.web_server_profiles import _config_profile_scope
            try:
                with _config_profile_scope(request.query_params.get("profile")):
                    return await handler(request)
            except HTTPException:
                raise
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
            except Exception as exc:
                logger.exception("Publisher plugin API error: %s", exc)
                raise HTTPException(500, f"Internal server error: {exc}") from exc
        return scoped


router = APIRouter(route_class=ScopedRoute)


class SaveTokenRequest(BaseModel):
    token: str


class CheckRequest(BaseModel):
    path: str
    target_type: str = "auto"


class PublishPluginRequest(BaseModel):
    path: str
    repo_url: Optional[str] = ""
    commit_sha: Optional[str] = ""
    target_repo: Optional[str] = publisher.DEFAULT_TARGET_REPO
    category: Optional[str] = "tools"
    maintainer: Optional[str] = ""
    dry_run: bool = False


class PublishSkillRequest(BaseModel):
    path: str
    target_repo: Optional[str] = publisher.DEFAULT_TARGET_REPO
    skill_name: Optional[str] = ""
    dest_dir: Optional[str] = "optional-skills"
    dry_run: bool = False


@router.get("/auth")
async def get_github_auth():
    """Return current GitHub authentication and token status."""
    return publisher.get_auth_status()


@router.post("/auth/token")
async def save_github_token_endpoint(body: SaveTokenRequest):
    """Validate and save a GitHub Personal Access Token to the active profile .env."""
    res = publisher.save_github_token(body.token)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "保存 GitHub Token 失败"))
    return res


@router.delete("/auth/token")
async def clear_github_token_endpoint():
    """Remove saved GITHUB_TOKEN from the active profile .env."""
    return publisher.clear_github_token()


@router.post("/check")
async def check_item(body: CheckRequest):
    """Run pre-flight validation on a plugin or skill."""
    res = publisher.check_target(body.path, target_type=body.target_type)
    return res


@router.post("/publish/plugin")
async def publish_plugin_endpoint(body: PublishPluginRequest):
    """Publish a validated plugin to the catalog."""
    res = publisher.publish_plugin(
        path=body.path,
        repo_url=body.repo_url or "",
        commit_sha=body.commit_sha or "",
        target_repo=body.target_repo or publisher.DEFAULT_TARGET_REPO,
        category=body.category or "tools",
        maintainer=body.maintainer or "",
        dry_run=body.dry_run,
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Plugin publishing failed"))
    return res


@router.post("/publish/skill")
async def publish_skill_endpoint(body: PublishSkillRequest):
    """Publish a validated skill to the community repository."""
    res = publisher.publish_skill(
        path=body.path,
        target_repo=body.target_repo or publisher.DEFAULT_TARGET_REPO,
        skill_name=body.skill_name or "",
        dest_dir=body.dest_dir or "optional-skills",
        dry_run=body.dry_run,
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Skill publishing failed"))
    return res
