"""Offline, verified migration of one profile's paper library. Originals are retained."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import yaml

LIBRARY_PATH = Path("plugin-data/paper-compare/library")
PARSER_KEYS = {"PDF_PARSER", "PDFTOTEXT_PATH", "PDFTOPPM_PATH", "PDFINFO_PATH", "MINERU_BASE_URL", "MINERU_TIER", "MINERU_API_KEY"}


def private_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        stream.write(text)
        temporary = Path(stream.name)
    try:
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def resolve_path(value, home):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else Path(home) / path).resolve()


def read_config(home):
    path = Path(home) / "config.yaml"
    text = path.read_text("utf-8") if path.exists() else ""
    config = yaml.safe_load(text) or {}
    entry = config.setdefault("plugins", {}).setdefault("entries", {}).setdefault("paper-compare", {})
    prefs = entry.setdefault("settings", dict(entry.get("config") or {}))
    return text, config, prefs


@contextmanager
def library_lease(directory):
    """Use the runtime's lease protocol, so an old server cannot restart during copying."""
    path = Path(directory) / ".hermes-paper.lock"
    fd = None
    for _ in range(2):
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            try:
                pid = json.loads(path.read_text())["pid"]
                if not isinstance(pid, int) or pid <= 0:
                    raise ValueError("Invalid library lease")
                os.kill(pid, 0)
            except ProcessLookupError:
                path.unlink()
                continue
            raise RuntimeError("论文库仍在使用中；请等待任务结束并停止论文服务后再迁移。") from None
    if fd is None:
        raise RuntimeError("无法取得论文库迁移锁。")
    try:
        os.write(fd, json.dumps({"pid": os.getpid()}).encode())
        yield
    finally:
        try:
            held, current = os.fstat(fd), path.stat()
            if (held.st_dev, held.st_ino) == (current.st_dev, current.st_ino):
                path.unlink()
        except FileNotFoundError:
            pass
        os.close(fd)


def _database_reader(path):
    # A closed WAL database may need SQLite to initialize auxiliary files.
    # mode=rw never creates a missing database; query_only forbids data writes.
    connection = sqlite3.connect(Path(path).as_uri() + "?mode=rw", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def audit(directory):
    directory = Path(directory)
    connection = _database_reader(directory / "library.sqlite")
    try:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("论文数据库完整性检查失败，原库未修改。")
        tables = {}
        for table in ("documents", "records", "events", "imports", "search_index"):
            value, count = hashlib.sha256(), 0
            for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid'):
                value.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
                value.update(b"\n")
                count += 1
            tables[table] = {"rows": count, "sha256": value.hexdigest()}
        counts = dict(connection.execute("SELECT kind,COUNT(*) FROM records GROUP BY kind"))
    finally:
        connection.close()
    files = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("论文库包含符号链接，请先改为实际文件再迁移。")
        if path.is_file() and path.name not in ("library.sqlite", "library.sqlite-wal", "library.sqlite-shm", ".hermes-paper.lock"):
            files[path.relative_to(directory).as_posix()] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    return {"tables": tables, "counts": counts, "files": files, "integrity": "ok"}


def snapshot(source, destination):
    """Back up SQLite through its backup API; never copy a live WAL database as one file."""
    source, destination = Path(source), Path(destination)
    before = audit(source)
    destination.mkdir(parents=True, mode=0o700)
    for relative in before["files"]:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(source / relative, target)
        target.chmod(0o600)
    reader = _database_reader(source / "library.sqlite")
    writer = sqlite3.connect(destination / "library.sqlite")
    try:
        reader.backup(writer)
        # A portable snapshot must open read-only without a writable WAL/SHM
        # sidecar, including with macOS's system SQLite.
        writer.execute("PRAGMA journal_mode=DELETE")
    finally:
        writer.close()
        reader.close()
    (destination / "library.sqlite").chmod(0o600)
    if audit(destination) != before:
        raise RuntimeError("论文库备份校验不一致，原库与配置均未修改。")
    return before


def migrate(home, source=None):
    home = Path(home).expanduser().resolve()
    raw, config, prefs = read_config(home)
    source = resolve_path(source or prefs.get("data_dir") or LIBRARY_PATH, home)
    target = (home / LIBRARY_PATH).resolve()
    if not (source / "library.sqlite").is_file():
        raise ValueError("源目录没有论文数据库，未进行迁移。")
    if source == target:
        return {"migrated": False, "directory": str(target), "reason": "already-profile-local"}
    if target.exists():
        raise ValueError("配置档案的目标论文库已经存在；为保护现有数据，不会覆盖或自动合并。")
    if source in target.parents or target in source.parents:
        raise ValueError("源论文库与目标论文库不能相互包含。")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = home / "backups/paper-compare" / stamp
    stage = target.parent / (".library-migrating-" + uuid.uuid4().hex)
    report = {"status": "preparing", "source": str(source), "target": str(target), "backup": str(backup)}
    published = False
    created_parser = None
    with library_lease(source):
        try:
            before = snapshot(source, backup / "library")
            private_write(backup / "config.yaml", raw)
            # Preserve the legacy Desktop/browser preference namespace for this same library.
            prefs.setdefault("browser_storage_scope", hashlib.sha256(json.dumps([str(home), str(source)], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
            if prefs.get("vision_report"):
                external = resolve_path(prefs["vision_report"], home)
                if external.is_file() and not (backup / "library/vision-capabilities.json").exists():
                    shutil.copy2(external, backup / "library/vision-capabilities.json")
                    (backup / "library/vision-capabilities.json").chmod(0o600)
            parser_values = {}
            if prefs.get("env_file"):
                from agent.secret_scope import load_env_file
                parser_values = {key: value for key, value in load_env_file(resolve_path(prefs["env_file"], home)).items() if key in PARSER_KEYS}
                private_write(backup / "parser.env", "\n".join(f"{key}={json.dumps(value, ensure_ascii=False)}" for key, value in parser_values.items()) + "\n")
            report.update(status="backed-up", audit=before)
            private_write(backup / "migration.json", json.dumps(report, ensure_ascii=False, indent=2))
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copytree(backup / "library", stage)
            expected = audit(backup / "library")
            if audit(stage) != expected:
                raise RuntimeError("迁入副本校验失败，原库与配置保持不变。")
            if target.exists():
                raise RuntimeError("迁移期间目标目录被占用，未覆盖目标。")
            stage.rename(target)
            published = True
            if parser_values:
                parser_path = home / "plugin-data/paper-compare/parser.env"
                if parser_path.exists():
                    raise ValueError("目标解析配置文件已存在，未覆盖。")
                private_write(parser_path, (backup / "parser.env").read_text("utf-8"))
                created_parser = parser_path
                prefs["env_file"] = str(parser_path.relative_to(home))
            else:
                prefs.pop("env_file", None)
            prefs.pop("vision_report", None)
            prefs.pop("data_dir", None)
            private_write(home / "config.yaml", yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
            report.update(status="migrated", migrated=True, audit=expected, originalRetained=True)
            try:
                private_write(backup / "migration.json", json.dumps(report, ensure_ascii=False, indent=2))
            except OSError:
                # Configuration is already published: a reader may have opened
                # the new library. Never remove a valid, potentially live target.
                report["reportWarning"] = "数据迁移与配置切换已完成，最终迁移日志未能更新；原始备份仍保留。"
            return report
        except BaseException:
            if published:
                shutil.rmtree(target)
                private_write(home / "config.yaml", raw)
            if created_parser:
                created_parser.unlink(missing_ok=True)
            shutil.rmtree(stage, ignore_errors=True)
            report["status"] = "failed-original-retained"
            if backup.exists():
                private_write(backup / "migration.json", json.dumps(report, ensure_ascii=False, indent=2))
            raise
