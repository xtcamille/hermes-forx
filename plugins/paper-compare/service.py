"""Local sidecar lifecycle. Data and credentials belong to an explicit ForX home."""
from __future__ import annotations

import atexit
import json
import os
import select
import shutil
import subprocess
import threading
import tempfile
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import yaml

ROOT = Path(__file__).resolve().parent
_services = {}
_lock = threading.RLock()


def settings(home):
    home = Path(home).resolve()
    config_file = home / "config.yaml"
    cfg = yaml.safe_load(config_file.read_text("utf-8")) if config_file.exists() else {}
    entry = ((cfg or {}).get("plugins", {}).get("entries", {}).get("paper-compare", {}))
    return entry.get("settings", entry.get("config", {})) or {}


def _path(value, home):
    path = Path(value).expanduser()
    return (path if path.is_absolute() else home / path).resolve()


@contextmanager
def _provider_scope(home):
    """Resolve through ForX's provider stack in the explicit owning profile."""
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope, reset_secret_scope
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    from hermes_constants import get_process_hermes_home, set_hermes_home_override, reset_hermes_home_override
    from tui_gateway.launch_profile_policy import launch_secret_scope

    home = Path(home).resolve()
    hydrate_profile_secret_sources(home)
    secrets = (launch_secret_scope(home) if home == get_process_hermes_home().resolve()
               else build_profile_secret_scope(home))
    home_token = set_hermes_home_override(str(home))
    secret_token = set_secret_scope(secrets)
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def resolve_connection(home):
    """Only the private parent/child pipe receives credentials; never a REST response."""
    connection = {"managedBy": "forx", "state": "login_required", "provider": "", "account": "", "model": "",
                  "message": "请在 ForX 的账号与模型设置中登录或配置模型接口。"}
    result = {"baseUrl": "http://127.0.0.1/v1", "apiKey": "", "extraHeaders": {}, "connection": connection}
    try:
        with _provider_scope(home):
            from hermes_cli.config import load_config_readonly
            from hermes_cli.runtime_provider import resolve_runtime_provider, resolve_requested_provider
            from hermes_cli.auth import get_auth_status
            from hermes_cli.auth_lattice import current_lattice_state

            model = load_config_readonly().get("model") or {}
            if not isinstance(model, dict):
                model = {}
            requested = resolve_requested_provider(model.get("provider"))
            connection.update(provider=requested, model=str(model.get("default") or ""))
            # Opening a paper must not mint another anonymous identity after logout.
            if requested == "latticecode" and not current_lattice_state():
                return result
            runtime = resolve_runtime_provider(requested=requested)
            provider = str(runtime.get("provider") or requested)
            connection["provider"] = provider
            if runtime.get("api_mode", "chat_completions") != "chat_completions":
                connection.update(state="unsupported", message="当前 ForX 提供商使用其他调用协议。请在 ForX 中选择兼容 Chat Completions 的模型接口。")
                return result
            key = runtime.get("api_key") or ""
            if callable(key):
                key = key()
            key = str(key or "").strip()
            base = str(runtime.get("base_url") or "").rstrip("/")
            parsed = urlparse(base)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                connection.update(state="unsupported", message="ForX 当前模型接口地址不可用于论文问答，请在 ForX 模型设置中检查接口地址。")
                return result
            result.update(baseUrl=base, apiKey=str(key), extraHeaders=runtime.get("extra_headers") or {})
            status = get_auth_status(provider)
            connection.update(account=str(status.get("username") or "")[:120],
                              state="connected" if key else "login_required",
                              message="由 ForX 统一管理账号和模型接口。" if key else connection["message"])
            return result
    except Exception:
        # Provider exceptions can contain headers/URLs/tokens. Return only actionable copy.
        connection.update(state="unavailable", message="暂时无法读取 ForX 模型凭据，请在 ForX 中检查登录状态与模型接口后重试。")
        return result


def _credential_worker(item, home):
    try:
        for line in item["process"].stdout:
            message = json.loads(line)
            if message.get("type") != "credentials" or not isinstance(message.get("id"), int):
                continue
            value = resolve_connection(home)
            item["process"].stdin.write(json.dumps({"id": message["id"], "credentials": value}) + "\n")
            item["process"].stdin.flush()
    except (OSError, ValueError):
        pass


def configuration(home, frame_origin):
    from agent.secret_scope import build_profile_secret_scope, load_env_file

    home = Path(home).resolve()
    prefs = settings(home)
    secrets = build_profile_secret_scope(home)
    if prefs.get("env_file"):
        private_file = _path(prefs["env_file"], home)
        if not private_file.is_file():
            raise ValueError("论文工具的私有配置文件不存在，请检查插件 env_file 设置。")
        # Migration compatibility for MinerU/Poppler only. ForX owns all LLM auth.
        legacy = load_env_file(private_file)
        secrets.update({key: value for key, value in legacy.items()
                        if key.startswith("MINERU_") or key in ("PDF_PARSER", "PDFTOTEXT_PATH", "PDFTOPPM_PATH", "PDFINFO_PATH")})
    own_node = home / "plugin-data/paper-compare/runtime/node/bin" / ("node.exe" if os.name == "nt" else "node")
    node = prefs.get("node_path") or (str(own_node) if own_node.is_file() else shutil.which("node"))
    if node and len(Path(node).parts) > 1:
        node = str(_path(node, home))
    if not node:
        raise ValueError("未找到 Node.js，请安装 Node.js 22.13+ 或配置插件 node_path。")
    result = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10, check=True)
    version = tuple(int(p) for p in result.stdout.strip().lstrip("v").split(".")[:2])
    if version < (22, 13):
        raise ValueError("论文工作台需要 Node.js 22.13 或更新版本。")
    if not (ROOT / "runtime/node_modules/katex").is_dir():
        raise ValueError("论文插件依赖尚未安装，请在插件 runtime 目录运行 npm ci。")
    if frame_origin not in ("null", "file:", "file://"):
        origin = urlparse(frame_origin)
        if origin.scheme not in ("http", "https") or origin.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("此插件需要本机 ForX 后端；当前支持本机桌面端与本机 Dashboard。")
    directory = _path(prefs.get("data_dir") or "plugin-data/paper-compare/library", home)
    port_file = home / "plugin-data/paper-compare/port.json"
    saved_port = json.loads(port_file.read_text("utf-8")).get("port", 0) if port_file.exists() else 0
    port = prefs.get("port", saved_port)
    if not isinstance(port, int) or port and not 1024 <= port <= 65535:
        raise ValueError("论文插件 port 需为 1024–65535，或 0 自动分配。")
    parser = prefs.get("pdf_parser") or secrets.get("PDF_PARSER") or "mineru"
    parser_config = {"provider": parser}
    for field, setting, env_key in (
        ("baseUrl", "mineru_base_url", "MINERU_BASE_URL"),
        ("tier", "mineru_tier", "MINERU_TIER"),
    ):
        if value := prefs.get(setting) or secrets.get(env_key):
            parser_config[field] = value
    parser_config["apiKey"] = secrets.get("MINERU_API_KEY", "")
    config = {
        "baseUrl": "http://127.0.0.1/v1", "apiKey": "", "managedConnection": True,
        "dataDirectory": str(directory), "pdfParser": parser_config,
        "frameOrigin": frame_origin, "parentPid": os.getpid(), "instance": uuid.uuid4().hex,
        "port": port, "storageScope": str(home),
        "browserStorageScope": prefs.get("browser_storage_scope"),
    }
    if prefs.get("vision_report"):
        config["visionReport"] = str(_path(prefs["vision_report"], home))
    # Credentials travel only over private stdin, never argv or browser state.
    child_env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT") if key in os.environ}
    for key in ("PDFTOTEXT_PATH", "PDFTOPPM_PATH", "PDFINFO_PATH"):
        if secrets.get(key):
            child_env[key] = secrets[key]
    return str(node), config, child_env


def _healthy(item):
    if item["process"].poll() is not None:
        return None
    try:
        with urllib.request.urlopen(item["url"] + "integration/status", timeout=3) as response:
            status = json.load(response)
        if status.get("instance") == item["instance"]:
            return status
    except (OSError, ValueError):
        return None


def launch(home, frame_origin="null"):
    home = Path(home).resolve()
    key = str(home)
    with _lock:
        previous = _services.get(key)
        if previous:
            if _healthy(previous):
                return {"url": previous["url"], "reused": True, "profileScoped": True}
            if previous["process"].poll() is None:
                raise RuntimeError("论文服务暂时没有响应，已有生成仍会保留，请稍后重新连接。")
            del _services[key]
        node, config, child_env = configuration(home, frame_origin)
        log_dir = home / "plugin-data/paper-compare"
        log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        log_path = log_dir / "service.log"
        with log_path.open("ab") as log:
            log_path.chmod(0o600)
            process = subprocess.Popen([node, str(ROOT / "sidecar.mjs")], cwd=ROOT, env=child_env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            process.stdin.write(json.dumps(config) + "\n")
            process.stdin.flush()
            if not select.select([process.stdout], [], [], 25)[0]:
                raise RuntimeError("论文服务启动超时，请查看插件 service.log。")
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("论文服务启动失败，请检查依赖、数据目录占用和插件 service.log。")
            ready = json.loads(line)
            if not ready.get("ready") or not ready.get("url", "").startswith("http://127.0.0.1:"):
                raise RuntimeError("论文服务未返回有效的本机就绪信息。")
            item = {"process": process, "url": ready["url"], "instance": config["instance"]}
            if not _healthy(item):
                raise RuntimeError("论文服务未通过就绪检查。")
            with tempfile.NamedTemporaryFile("w", dir=log_dir, delete=False) as out:
                json.dump({"port": urlparse(item["url"]).port}, out); temp = out.name
            os.chmod(temp, 0o600); os.replace(temp, log_dir / "port.json")
            _services[key] = item
            from agent.memory_provider import spawn_context_thread
            item["worker"] = spawn_context_thread(lambda: _credential_worker(item, home), name="paper-forx-credentials")
            item["worker"].start()
            return {"url": item["url"], "reused": False, "profileScoped": True}
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)
            process.stdout.close()
            process.stdin.close()
            raise


def status(home):
    with _lock:
        item = _services.get(str(Path(home).resolve()))
        state = _healthy(item) if item else None
        return {"plugin": "paper-compare", "running": bool(state), "activeJobs": state.get("activeJobs", 0) if state else 0}


def shutdown():
    with _lock:
        for item in _services.values():
            process = item["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)
            if item.get("worker"):
                item["worker"].join(timeout=1)
            process.stdout.close()
            process.stdin.close()
        _services.clear()


atexit.register(shutdown)
