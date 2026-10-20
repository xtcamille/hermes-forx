"""Authenticated Hermes entry point; each profile owns one local workbench process."""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

# Dashboard API modules are loaded by filename, outside the agent plugin namespace.
# Give the sidecar manager a stable package-local identity without changing sys.path.
_path = Path(__file__).resolve().parents[1] / "service.py"
_name = "paper_compare_service_" + __import__("hashlib").sha256(str(_path).encode()).hexdigest()[:16]
if _name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_name, _path)
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_name] = _module
    _spec.loader.exec_module(_module)
service = sys.modules[_name]


@asynccontextmanager
async def lifespan(app):
    try:
        yield
    finally:
        await asyncio.to_thread(service.shutdown)


router = APIRouter(lifespan=lifespan)


class Launch(BaseModel):
    frameOrigin: str = Field(default="null", max_length=256)


def _home(profile):
    from hermes_constants import get_hermes_home
    if not profile or profile == "current":
        return get_hermes_home()
    from hermes_cli.profiles import get_profile_dir, profile_exists
    if not profile_exists(profile):
        raise HTTPException(404, "Profile not found")
    return get_profile_dir(profile)


@router.get("/status")
async def status(profile: str | None = Query(None)):
    return service.status(_home(profile))


@router.post("/launch")
async def launch(body: Launch, profile: str | None = Query(None)):
    home = _home(profile)
    try:
        # Settings and secrets are resolved for this home in the worker, never
        # inherited from a previous request or from a different agent's turn.
        return await asyncio.to_thread(service.launch, home, body.frameOrigin)
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(503, str(exc)) from None
