"""The existing CLI+skill surface also makes projects editable from agent chats."""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from pathlib import Path


def setup(parser):
    parser.add_argument("action", choices=["list", "show", "create", "edit", "chat", "undo", "redo", "export", "import", "doctor"])
    parser.add_argument("--project", help="Stable project identity")
    parser.add_argument("--revision", type=int, help="Expected current revision for writes")
    parser.add_argument("--input", help="UTF-8 JSON draft or operation list")
    parser.add_argument("--prompt", help="Natural language request, using the host's active model")
    parser.add_argument("--output", help="Destination PPTX/project path")
    parser.add_argument("--request-id", default=None, help="Reuse this key when retrying the same request")


def run(args, client=None):
    from . import planner
    from .models import Deck, new_deck
    from .storage import Store, encoded
    store = Store()
    request_id = args.request_id or uuid.uuid4().hex

    def require_project():
        if not args.project:
            raise ValueError("需要 --project")
        return args.project

    def read_input():
        if not args.input:
            raise ValueError("需要 --input JSON文件")
        return json.loads(Path(args.input).read_text(encoding="utf-8"))

    def create():
        data = read_input()
        return store.create(new_deck(data["name"], data["slides"], data.get("theme", "business"), data.get("ratio", "16:9")),
                            request_id, encoded(data))

    def edit():
        if args.revision is None:
            raise ValueError("需要 --revision；先 show 获取当前版本")
        return store.edit(require_project(), args.revision, read_input(), request_id)

    def chat():
        if not args.prompt:
            raise ValueError("需要 --prompt")
        return asyncio.run(planner.converse(args.prompt, request_id, args.project, args.revision, client=client))

    def export():
        from .pptx_io import export_pptx
        if not args.output:
            raise ValueError("需要 --output")
        result = store.get(require_project())
        if args.revision is not None and args.revision != result["revision"]:
            raise ValueError("文稿版本已变化，请重新 show")
        deck = Deck.model_validate(result["deck"])
        path = Path(args.output).expanduser().resolve()
        if path.suffix.lower() not in (".forxppt", ".pptx"):
            raise ValueError("导出文件扩展名需要为 .pptx 或 .forxppt")
        data = encoded(store.bundle(deck)).encode() if path.suffix.lower() == ".forxppt" else export_pptx(deck, store)
        path.write_bytes(data)
        return {"path": str(path), "revision": result["revision"]}

    def import_file():
        from .pptx_io import import_pptx
        if not args.input:
            raise ValueError("需要 --input")
        path = Path(args.input)
        blob = path.read_bytes()
        bundle = import_pptx(blob) if path.suffix.lower() == ".pptx" else json.loads(blob)
        return store.import_bundle(bundle, request_id, hashlib.sha256(blob).hexdigest())

    handlers = {
        "list": store.list, "show": lambda: store.get(require_project()), "create": create,
        "edit": edit, "chat": chat, "export": export, "import": import_file,
        "undo": lambda: store.travel(require_project(), args.revision, "undo", request_id),
        "redo": lambda: store.travel(require_project(), args.revision, "redo", request_id),
        "doctor": lambda: {"ready": __import__("importlib.util", fromlist=["find_spec"]).find_spec("pptx") is not None,
                           "storage": str(store.path), "preview": "scene", "desktop": "PPT 创作台"},
    }
    try:
        result = handlers[args.action]()
    except (ValueError, KeyError, OSError) as exc:
        print(encoded({"error": str(exc)}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
