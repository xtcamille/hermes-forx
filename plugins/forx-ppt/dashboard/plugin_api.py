"""Authenticated plugin routes; native host middleware supplies authentication."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, ValidationError


# The host loads this file outside the agent plugin package. A path-owned package
# keeps relative imports valid for both installed plugins and source checkouts.
_root = Path(__file__).resolve().parents[1]
_name = "forx_ppt_" + hashlib.sha256(str(_root).encode()).hexdigest()[:16]
if _name not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_name, _root / "__init__.py", submodule_search_locations=[str(_root)])
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_name] = _module
    _spec.loader.exec_module(_module)
models = __import__(_name + ".models", fromlist=["Deck"])
storage = __import__(_name + ".storage", fromlist=["Store"])
planner = __import__(_name + ".planner", fromlist=["converse"])
preview = __import__(_name + ".preview", fromlist=["render"])
themes = __import__(_name + ".themes", fromlist=["THEMES"])
visual_gen = __import__(_name + ".visual_gen", fromlist=["create_presentation_visual"])


class ScopedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def scoped(request: Request):
            from hermes_cli.web_server_profiles import _config_profile_scope
            try:
                with _config_profile_scope(request.query_params.get("profile")):
                    from hermes_cli.config import load_config
                    config = load_config().get("plugins", {})
                    if "forx-ppt" not in config.get("enabled", []) or "forx-ppt" in config.get("disabled", []):
                        raise HTTPException(403, "请在当前配置中启用 forx-ppt 后端插件")
                    return await handler(request)
            except storage.Conflict as exc:
                raise HTTPException(409, str(exc)) from exc
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
            except (ValueError, ValidationError) as exc:
                raise HTTPException(422, str(exc)) from exc
        return scoped


router = APIRouter(route_class=ScopedRoute)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Create(Body):
    name: str = Field(min_length=1, max_length=128)
    slides: list[dict] = Field(default_factory=lambda: [{"title": "新演示文稿", "bullets": ["在右侧对话中描述你想表达的内容。"]}], min_length=1, max_length=30)
    theme: str = "business"
    ratio: str = "16:9"
    request_id: str = Field(min_length=1, max_length=128)


class Edit(Body):
    revision: int = Field(ge=1)
    operations: list[dict] = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=1, max_length=128)
    label: str = Field("编辑文稿", max_length=2000)


class Travel(Body):
    revision: int = Field(ge=1)
    request_id: str = Field(min_length=1, max_length=128)


class Restore(Travel):
    version: int = Field(ge=1)


class Chat(Body):
    prompt: str = Field(min_length=1, max_length=20000)
    project_id: str | None = None
    revision: int | None = Field(None, ge=1)
    selection: list[str] = Field(default_factory=list, max_length=60)
    request_id: str = Field(min_length=1, max_length=128)


class DocToDeck(Body):
    text: str = Field(min_length=5, max_length=100000)
    title: str | None = Field(None, max_length=128)
    target_pages: int = Field(8, ge=2, le=30)
    theme: str = "business"
    ratio: str = "16:9"
    request_id: str = Field(min_length=1, max_length=128)


class Cancel(Body):
    request_id: str = Field(min_length=1, max_length=128)


class GenerateImage(Body):
    prompt: str = Field(min_length=1, max_length=2000)
    aspect_ratio: str = "landscape"
    style: str = "illustration"
    project_id: str | None = None
    slide_id: str | None = None
    request_id: str = Field(min_length=1, max_length=128)


@router.get("/status")
async def status():
    from hermes_constants import hermes_home_key
    from importlib.util import find_spec
    return {"ready": find_spec("pptx") is not None, "scope": hashlib.sha256(hermes_home_key().encode()).hexdigest()[:24],
            "themes": {key: value["name"] for key, value in themes.THEMES.items()},
            "limits": {"slides": 30, "image_mb": 10}, "preview": "scene"}


@router.get("/projects")
async def projects():
    return {"projects": storage.Store().list()}


@router.post("/projects")
async def create(body: Create):
    fingerprint = storage.encoded(body.model_dump(exclude={"request_id"}))
    replay = storage.Store().replay(body.request_id, fingerprint)
    if replay:
        return replay
    deck = models.new_deck(body.name, body.slides, body.theme, body.ratio)
    return storage.Store().create(deck, body.request_id, fingerprint)


@router.post("/projects/from-doc")
async def from_doc(body: DocToDeck):
    try:
        return await planner.convert_document(
            body.text,
            title=body.title,
            target_pages=body.target_pages,
            theme_name=body.theme,
            ratio=body.ratio,
            request_id=body.request_id,
        )
    except (ValueError, KeyError):
        raise
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("PPT doc conversion failed")
        raise HTTPException(502, "文档转 PPT 失败，请检查模型连接与文本内容后重试。") from exc


@router.post("/generate-image")
async def generate_image(body: GenerateImage):
    clean_prompt = body.prompt.strip()
    presets = {
        "illustration": "Minimalist modern flat vector illustration for enterprise presentation, clean geometric shapes, sophisticated corporate color palette, white background, no text, high resolution",
        "tech": "Futuristic deep tech cyberspace illustration, dark mode, glowing cyan and azure accents, sleek isometric digital infrastructure, professional presentation visual, 8k",
        "3d": "Modern 3D clay and glassmorphic isometric render, clean lighting, soft shadows, vibrant aesthetic, enterprise business concept, studio lighting",
        "photo": "Professional high-end commercial corporate photography, cinematic lighting, ultra-detailed, depth of field, 8k resolution",
    }
    style_addon = presets.get(body.style, presets["illustration"])
    enhanced_prompt = f"{clean_prompt}, {style_addon}"

    raw_png_bytes = None
    provider_name = "visual-engine"
    try:
        from agent.image_gen_registry import get_active_provider
        active_p = get_active_provider()
        if active_p is not None and getattr(active_p, "is_available", lambda: False)():
            res = active_p.generate(enhanced_prompt, aspect_ratio=body.aspect_ratio)
            if res.get("success") and res.get("image"):
                img_path = res["image"]
                from pathlib import Path
                if Path(img_path).is_file():
                    raw_png_bytes = Path(img_path).read_bytes()
                    provider_name = res.get("provider", "ai-provider")
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Active image gen provider failed, falling back to visual generator: %s", exc)

    if raw_png_bytes is None:
        raw_png_bytes = visual_gen.create_presentation_visual(clean_prompt, aspect_ratio=body.aspect_ratio, style=body.style)
        provider_name = "forx-visual-engine"

    store = storage.Store()
    asset_info = store.upload(raw_png_bytes)
    asset_id = asset_info["asset_id"]

    updated_deck = None
    if body.project_id and body.slide_id:
        try:
            curr = store.get(body.project_id)
            target_slide = next((s for s in curr["deck"]["slides"] if s["id"] == body.slide_id), None)
            w = curr["deck"].get("width", 13.333333)
            if target_slide and target_slide.get("layout_id") == "L004":
                box = {"x": round(w / 2 + 0.3, 3), "y": 1.9, "width": round(w / 2 - 0.9, 3), "height": 4.8}
            else:
                box = {"x": round(w - 6.0, 3), "y": 2.0, "width": 5.4, "height": 4.6}
            op = {
                "action": "add_element",
                "slide_id": body.slide_id,
                "element": {
                    "name": f"AI配图: {clean_prompt[:16]}",
                    "kind": "image",
                    "asset_id": asset_id,
                    "box": box,
                }
            }
            updated_deck = store.edit(body.project_id, curr["revision"], [op], body.request_id, f"AI生成配图: {clean_prompt[:20]}")
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Auto-insert into slide failed: %s", exc)

    return {
        "success": True,
        "asset_id": asset_id,
        "width": asset_info["width"],
        "height": asset_info["height"],
        "provider": provider_name,
        "prompt": clean_prompt,
        "result": updated_deck,
    }


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    return storage.Store().get(project_id)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    return storage.Store().delete(project_id)


@router.get("/projects/{project_id}/history")
async def history(project_id: str):
    return {"history": storage.Store().history(project_id)}


@router.post("/projects/{project_id}/edit")
async def edit(project_id: str, body: Edit):
    return storage.Store().edit(project_id, body.revision, body.operations, body.request_id, body.label)


@router.post("/projects/{project_id}/{direction}")
async def travel(project_id: str, direction: str, body: Travel):
    if direction not in ("undo", "redo"):
        raise HTTPException(404, "未知操作")
    return storage.Store().travel(project_id, body.revision, direction, body.request_id)


@router.post("/restore/{project_id}")
async def restore(project_id: str, body: Restore):
    return storage.Store().edit(project_id, body.revision, [], body.request_id, f"恢复版本 v{body.version}", restore_version=body.version)


@router.get("/projects/{project_id}/preview/{slide_id}")
async def view(project_id: str, slide_id: str, revision: int | None = None, numbers: bool = False):
    current = storage.Store().get(project_id)
    if revision is not None and revision != current["revision"]:
        raise storage.Conflict("预览版本已变化，请刷新文稿")
    deck = models.Deck.model_validate(current["deck"])
    slide = next((s for s in deck.slides if s.id == slide_id), None)
    if not slide:
        raise KeyError("未找到页面")
    return {**preview.render(deck, slide, numbers), "revision": current["revision"]}


@router.get("/assets/{asset_id}")
async def asset(asset_id: str):
    return {"data": base64.b64encode(storage.Store().asset(asset_id)).decode(), "content_type": "image/png"}


async def limited_body(request, limit):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            raise HTTPException(413, "上传文件超过大小限制")
    return bytes(raw)


@router.post("/assets")
async def upload(request: Request):
    raw = await limited_body(request, 14 * 1024 * 1024)
    data = json.loads(raw)
    return storage.Store().upload(base64.b64decode(data["data"], validate=True))


@router.get("/projects/{project_id}/download")
async def download(project_id: str, revision: int, format: str = "pptx"):
    store = storage.Store()
    current = store.get(project_id)
    if current["revision"] != revision:
        raise storage.Conflict("文稿已更新，请导出当前版本")
    deck = models.Deck.model_validate(current["deck"])
    if format == "pptx":
        from importlib import import_module
        data = await asyncio.to_thread(import_module(_name + ".pptx_io").export_pptx, deck, store)
        mime, suffix = "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"
    elif format == "project":
        data = storage.encoded(store.bundle(deck)).encode()
        mime, suffix = "application/json", ".forxppt"
    else:
        raise ValueError("不支持的导出格式")
    return {"filename": deck.name + suffix, "content_type": mime, "data": base64.b64encode(data).decode(), "revision": revision}


@router.post("/import")
async def import_project(request: Request):
    payload = json.loads(await limited_body(request, 110 * 1024 * 1024))
    raw = base64.b64decode(payload["data"], validate=True)
    if payload.get("format") == "pptx":
        from importlib import import_module
        bundle = await asyncio.to_thread(import_module(_name + ".pptx_io").import_pptx, raw)
    else:
        bundle = json.loads(raw)
    fingerprint = hashlib.sha256(raw).hexdigest()
    return storage.Store().import_bundle(bundle, payload["request_id"], fingerprint)


@router.post("/chat")
async def chat(body: Chat):
    try:
        return await planner.converse(body.prompt, body.request_id, body.project_id, body.revision, body.selection)
    except (ValueError, KeyError):
        raise
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("PPT model request failed")
        raise HTTPException(502, "模型调用失败，请检查 ForX 的账号与模型设置后重试；原文稿未改变。") from exc


@router.post("/cancel")
async def cancel(body: Cancel):
    return storage.Store().cancel(body.request_id)
