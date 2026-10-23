"""Profile-local SQLite revisions with optimistic writes and durable retry keys."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone

from PIL import Image, UnidentifiedImageError

from .models import Deck, all_elements, quality_issues
from .operations import apply
from .changes import describe


class Conflict(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self):
        from plugins.plugin_storage import plugin_data_dir
        self.path = plugin_data_dir("forx-ppt") / "projects.db"

    @contextmanager
    def connection(self):
        from hermes_cli.sqlite_util import open_db
        with closing(open_db(self.path, db_label="forx-ppt", foreign_keys=True, check_same_thread=False)) as db:
            db.row_factory = sqlite3.Row
            db.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, version INTEGER NOT NULL, cursor INTEGER NOT NULL,
                    name TEXT NOT NULL, seq_e INTEGER NOT NULL, seq_s INTEGER NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots (
                    project_id TEXT NOT NULL REFERENCES projects(id), ordinal INTEGER NOT NULL,
                    state TEXT NOT NULL, PRIMARY KEY(project_id, ordinal));
                CREATE TABLE IF NOT EXISTS events (
                    project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL,
                    label TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(project_id, version));
                CREATE TABLE IF NOT EXISTS requests (
                    request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id));
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY, data BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS cancellations (request_id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS versions (
                    project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL,
                    state TEXT NOT NULL, PRIMARY KEY(project_id,version));
                CREATE TABLE IF NOT EXISTS changes (
                    project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL,
                    operations TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(project_id,version));
            """)
            yield db

    def list(self):
        with self.connection() as db:
            return [dict(row) for row in db.execute("SELECT id,name,version AS revision,updated FROM projects ORDER BY updated DESC")]

    def _row(self, db, project_id):
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise KeyError("未找到文稿")
        return row

    def _load(self, db, row):
        state = db.execute("SELECT state FROM snapshots WHERE project_id=? AND ordinal=?", (row["id"], row["cursor"])).fetchone()
        deck = Deck.model_validate_json(state[0])
        deck.counters = {"E": row["seq_e"], "S": row["seq_s"]}
        return deck

    def get(self, project_id):
        with self.connection() as db:
            db.execute("BEGIN")
            row = self._row(db, project_id)
            deck = self._load(db, row)
            last = db.execute("SELECT MAX(ordinal) FROM snapshots WHERE project_id=?", (project_id,)).fetchone()[0]
            change = db.execute("SELECT summary FROM changes WHERE project_id=? AND version=?", (project_id, row["version"])).fetchone()
            return {"deck": deck.model_dump(), "revision": row["version"], "undo_available": row["cursor"] > 0,
                    "redo_available": row["cursor"] < last, "issues": quality_issues(deck), "change": json.loads(change[0]) if change else None}

    def history(self, project_id):
        with self.connection() as db:
            self._row(db, project_id)
            result = []
            for row in db.execute("SELECT e.version,e.label,e.created,c.operations,c.summary FROM events e LEFT JOIN changes c ON e.project_id=c.project_id AND e.version=c.version WHERE e.project_id=? ORDER BY e.version DESC LIMIT 100", (project_id,)):
                item = dict(row)
                for field in ("operations", "summary"):
                    item[field] = json.loads(item[field]) if item[field] else None
                result.append(item)
            return result

    def replay(self, request_id, fingerprint):
        if not request_id or len(request_id) > 128:
            raise ValueError("需要长度不超过 128 的 request_id")
        with self.connection() as db:
            row = db.execute("SELECT * FROM requests WHERE request_id=?", (request_id,)).fetchone()
            if row:
                if row["fingerprint"] != fingerprint:
                    raise Conflict("同一 request_id 不能用于不同指令")
                return self.get(row["project_id"])
        return None

    def _check_assets(self, db, deck):
        total = 0
        for asset in {e.asset_id for e in all_elements(deck) if e.asset_id}:
            row = db.execute("SELECT length(data) FROM assets WHERE id=?", (asset,)).fetchone()
            if row is None:
                raise ValueError(f"缺少图片素材 {asset[:12]}，请先上传")
            total += row[0]
        if total > 50 * 1024 * 1024:
            raise ValueError("文稿素材总量不能超过 50 MB")

    def _not_cancelled(self, db, request_id):
        if db.execute("SELECT 1 FROM cancellations WHERE request_id=?", (request_id,)).fetchone():
            raise Conflict("操作已取消，原文稿未改变")

    def cancel(self, request_id):
        if not request_id or len(request_id) > 128:
            raise ValueError("请求编号无效")
        with self.connection() as db, db:
            db.execute("BEGIN IMMEDIATE")
            completed = db.execute("SELECT project_id FROM requests WHERE request_id=?", (request_id,)).fetchone()
            if not completed:
                db.execute("INSERT OR IGNORE INTO cancellations VALUES(?)", (request_id,))
        return {"cancelled": not bool(completed), "result": self.get(completed[0]) if completed else None}

    def create(self, deck, request_id, fingerprint, label="创建文稿"):
        replay = self.replay(request_id, fingerprint)
        if replay:
            return replay
        deck = Deck.model_validate(deck.model_dump())
        with self.connection() as db, db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT fingerprint,project_id FROM requests WHERE request_id=?", (request_id,)).fetchone()
            if existing:
                if existing[0] != fingerprint:
                    raise Conflict("请求标识冲突")
                project_id = existing[1]
            else:
                self._not_cancelled(db, request_id)
                self._check_assets(db, deck)
                project_id = deck.id
                db.execute("INSERT INTO projects VALUES(?,1,0,?,?,?,?)", (deck.id, deck.name, deck.counters["E"], deck.counters["S"], now()))
                db.execute("INSERT INTO snapshots VALUES(?,0,?)", (deck.id, encoded(deck.model_dump())))
                db.execute("INSERT INTO versions VALUES(?,1,?)", (deck.id, encoded(deck.model_dump())))
                db.execute("INSERT INTO changes VALUES(?,1,?,?)", (deck.id, "[]", encoded(describe(None, deck))))
                db.execute("INSERT INTO events VALUES(?,1,?,?)", (deck.id, label[:2000], now()))
                db.execute("INSERT INTO requests VALUES(?,?,?)", (request_id, fingerprint, deck.id))
        return self.get(project_id)

    def edit(self, project_id, revision, operations, request_id, label="编辑文稿", fingerprint=None, restore_version=None):
        fingerprint = fingerprint or encoded([project_id, revision, operations, restore_version])
        replay = self.replay(request_id, fingerprint)
        if replay:
            return replay
        with self.connection() as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id)
            existing = db.execute("SELECT * FROM requests WHERE request_id=?", (request_id,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise Conflict("请求标识冲突")
            else:
                self._not_cancelled(db, request_id)
                if revision != row["version"]:
                    raise Conflict("文稿版本已变化，请刷新后重新核对目标")
                before = self._load(db, row)
                if restore_version is None:
                    deck = apply(before, operations)
                else:
                    saved = db.execute("SELECT state FROM versions WHERE project_id=? AND version=?", (project_id, restore_version)).fetchone()
                    if saved is None:
                        raise KeyError("未找到历史版本")
                    deck = Deck.model_validate_json(saved[0])
                    deck.counters = {"E": row["seq_e"], "S": row["seq_s"]}
                self._check_assets(db, deck)
                cursor, version = row["cursor"] + 1, row["version"] + 1
                db.execute("DELETE FROM snapshots WHERE project_id=? AND ordinal>?", (project_id, row["cursor"]))
                db.execute("INSERT INTO snapshots VALUES(?,?,?)", (project_id, cursor, encoded(deck.model_dump())))
                db.execute("INSERT INTO versions VALUES(?,?,?)", (project_id, version, encoded(deck.model_dump())))
                db.execute("INSERT INTO changes VALUES(?,?,?,?)", (project_id, version, encoded(operations if restore_version is None else [{"restore_version": restore_version}]), encoded(describe(before, deck))))
                db.execute("UPDATE projects SET version=?,cursor=?,name=?,seq_e=?,seq_s=?,updated=? WHERE id=?",
                           (version, cursor, deck.name, deck.counters["E"], deck.counters["S"], now(), project_id))
                db.execute("INSERT INTO events VALUES(?,?,?,?)", (project_id, version, label[:2000], now()))
                db.execute("INSERT INTO requests VALUES(?,?,?)", (request_id, fingerprint, project_id))
        return self.get(project_id)

    def travel(self, project_id, revision, direction, request_id):
        fingerprint = encoded([project_id, revision, direction])
        replay = self.replay(request_id, fingerprint)
        if replay:
            return replay
        with self.connection() as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id)
            completed = db.execute("SELECT fingerprint FROM requests WHERE request_id=?", (request_id,)).fetchone()
            if completed:
                if completed[0] != fingerprint:
                    raise Conflict("请求标识冲突")
                return self.get(project_id)
            if row["version"] != revision:
                raise Conflict("文稿版本已变化，请刷新后重试")
            cursor = row["cursor"] + ({"undo": -1, "redo": 1}[direction])
            state = db.execute("SELECT state FROM snapshots WHERE project_id=? AND ordinal=?", (project_id, cursor)).fetchone()
            if state is None:
                raise ValueError("没有可撤销或重做的修改")
            deck = Deck.model_validate_json(state[0])
            before = self._load(db, row)
            db.execute("UPDATE projects SET version=version+1,cursor=?,name=?,updated=? WHERE id=?", (cursor, deck.name, now(), project_id))
            db.execute("INSERT INTO events VALUES(?,?,?,?)", (project_id, revision + 1, direction, now()))
            deck.counters = {"E": row["seq_e"], "S": row["seq_s"]}
            db.execute("INSERT INTO versions VALUES(?,?,?)", (project_id, revision + 1, encoded(deck.model_dump())))
            db.execute("INSERT INTO changes VALUES(?,?,?,?)", (project_id, revision + 1, encoded([{"action": direction}]), encoded(describe(before, deck))))
            db.execute("INSERT INTO requests VALUES(?,?,?)", (request_id, fingerprint, project_id))
        return self.get(project_id)

    def upload(self, raw, *, imported=False):
        if not raw or len(raw) > (20 if imported else 10) * 1024 * 1024:
            raise ValueError("单张图片不超过 10 MB")
        try:
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > 40_000_000 or source.format not in {"PNG", "JPEG", "WEBP", "GIF"}:
                    raise ValueError("支持不超过 4000 万像素的 PNG、JPEG、WebP 或 GIF 首帧")
                image = source.convert("RGBA")
                stream = io.BytesIO()
                image.save(stream, format="PNG")
                data, width, height = stream.getvalue(), image.width, image.height
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("图片无法读取") from exc
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("解码后的图片超过 20 MB")
        asset_id = hashlib.sha256(data).hexdigest()
        with self.connection() as db, db:
            db.execute("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)", (asset_id, data, width, height))
        return {"asset_id": asset_id, "width": width, "height": height}

    def asset(self, asset_id):
        with self.connection() as db:
            row = db.execute("SELECT data FROM assets WHERE id=?", (asset_id,)).fetchone()
            if row is None:
                raise KeyError("未找到图片素材")
            return bytes(row[0])

    def bundle(self, deck):
        assets = {e.asset_id for e in all_elements(deck) if e.asset_id}
        return {"format": "forx-ppt-project", "version": 1, "deck": deck.model_dump(),
                "assets": {key: base64.b64encode(self.asset(key)).decode() for key in assets}}

    def import_bundle(self, bundle, request_id, fingerprint):
        import uuid
        if bundle.get("format") != "forx-ppt-project" or bundle.get("version") != 1:
            raise ValueError("不支持的项目格式")
        deck = Deck.model_validate(bundle["deck"])
        for key, data in bundle.get("assets", {}).items():
            result = self.upload(base64.b64decode(data, validate=True), imported=True)
            if result["asset_id"] != key:
                raise ValueError("素材校验失败")
        # Import is a separate work, never an overwrite of an existing project.
        deck.id = uuid.uuid4().hex
        return self.create(deck, request_id, fingerprint, "导入项目（新文稿）")
