"""Install a self-contained paper plugin into the selected ForX profile."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
TOP_FILES = {"__init__.py", "plugin.yaml", "service.py", "sidecar.mjs", "install.py", "storage.py", "migrate.py", "README.md"}


def _storage():
    import importlib.util
    spec = importlib.util.spec_from_file_location("paper_install_storage", ROOT / "storage.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _node(home, explicit):
    executable = "node.exe" if os.name == "nt" else "node"
    own = home / "plugin-data/paper-compare/runtime/node/bin" / executable
    selected = explicit or (str(own) if own.is_file() else shutil.which("node"))
    if not selected:
        raise ValueError("需要 Node.js 22.13+；安装后由 ForX 管理论文插件，无需单独启动服务。")
    path = Path(selected).expanduser()
    if not path.is_absolute():
        path = home / path if len(path.parts) > 1 else Path(shutil.which(str(path)) or str(path))
    path = path.resolve()
    version = subprocess.check_output([str(path), "--version"], text=True, timeout=10).strip()
    if tuple(int(part) for part in version.lstrip("v").split(".")[:2]) < (22, 13):
        raise ValueError("论文插件需要 Node.js 22.13+。")
    own.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path != own.resolve():
        temporary = own.with_name(".node-" + uuid.uuid4().hex)
        try:
            shutil.copy2(path, temporary)
            temporary.chmod(0o700)
            subprocess.run([str(temporary), "--version"], capture_output=True, check=True, timeout=10)
            os.replace(temporary, own)
        finally:
            temporary.unlink(missing_ok=True)
    npm_source = path.parent.parent / "lib/node_modules/npm"
    npm_target = own.parent.parent / "lib/node_modules/npm"
    if npm_source.is_dir() and npm_source.resolve() != npm_target.resolve() and not npm_target.exists():
        shutil.copytree(npm_source, npm_target, symlinks=True)
    license_path = path.parent.parent / "LICENSE"
    if license_path.is_file() and license_path.resolve() != (own.parent.parent / "LICENSE").resolve():
        shutil.copy2(license_path, own.parent.parent / "LICENSE")
    return own, version


def _copy_package(destination, *, reuse_dependencies):
    destination.mkdir(mode=0o700)
    for name in TOP_FILES:
        shutil.copy2(ROOT / name, destination / name)
    for name in ("desktop", "dashboard"):
        shutil.copytree(ROOT / name, destination / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    runtime = destination / "runtime"
    runtime.mkdir()
    for name in ("server.mjs", "package.json", "package-lock.json"):
        shutil.copy2(ROOT / "runtime" / name, runtime / name)
    for name in ("lib", "public", "test"):
        shutil.copytree(ROOT / "runtime" / name, runtime / name)
    (runtime / "scripts").mkdir()
    shutil.copy2(ROOT / "runtime/scripts/check-mineru.mjs", runtime / "scripts/check-mineru.mjs")
    if reuse_dependencies:
        if not (ROOT / "runtime/node_modules/katex").is_dir():
            raise ValueError("缺少可复用的运行依赖；请去掉 --skip-deps，让安装器自动安装。")
        shutil.copytree(ROOT / "runtime/node_modules", runtime / "node_modules", symlinks=True)
    for path in destination.rglob("*"):
        if path.is_symlink() and not path.resolve().is_relative_to(destination.resolve()):
            raise ValueError("插件包存在指向外部目录的符号链接，安装已停止。")


def _npm_ci(node, directory):
    cli = node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"
    if not cli.is_file():
        command = shutil.which("npm")
        if not command:
            raise ValueError("首次安装依赖需要 npm；请安装 Node.js，或使用包含运行依赖的插件包。")
        cli = Path(command).resolve()
    subprocess.run([str(node), str(cli), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=directory, check=True)


def install(home, *, data_dir=None, env_file=None, vision_report=None, node_path=None, skip_deps=False, link=False):
    storage = _storage()
    home = Path(home).expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    raw, config, prefs = storage.read_config(home)
    target = home / "plugins/paper-compare"
    target.parent.mkdir(parents=True, exist_ok=True)
    if data_dir and not (Path(data_dir).expanduser() / "library.sqlite").is_file():
        raise ValueError("Existing data_dir must contain library.sqlite; no library was changed.")
    if env_file and not Path(env_file).expanduser().is_file():
        raise ValueError("Private env_file does not exist; no configuration was changed.")
    if target.exists() or target.is_symlink():
        manifest = target / "plugin.yaml"
        if not manifest.is_file() or (yaml.safe_load(manifest.read_text()) or {}).get("name") != "paper-compare":
            raise RuntimeError("安装位置已被其他内容占用，未覆盖。")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = home / "backups/paper-compare-install" / stamp
    storage.private_write(backup / "config.yaml", raw)
    node, version = _node(home, node_path or prefs.get("node_path"))
    stage = target.parent / (".paper-compare-install-" + uuid.uuid4().hex)
    replaced = False
    published = False
    try:
        if link:
            stage.symlink_to(ROOT, target_is_directory=True)
        else:
            _copy_package(stage, reuse_dependencies=skip_deps)
            if not skip_deps:
                _npm_ci(node, stage / "runtime")
            subprocess.run([str(node), "--input-type=module", "-e", "await import('./server.mjs')"], cwd=stage / "runtime", check=True, capture_output=True)
        plugins = config.setdefault("plugins", {})
        enabled = plugins.setdefault("enabled", [])
        if "paper-compare" not in enabled:
            enabled.append("paper-compare")
        if "paper-compare" in plugins.get("disabled", []):
            plugins["disabled"].remove("paper-compare")
        prefs.pop("base_url", None)
        prefs["node_path"] = str(node.relative_to(home))
        for field, value in (("data_dir", data_dir), ("env_file", env_file), ("vision_report", vision_report)):
            if value:
                prefs[field] = str(Path(value).expanduser().resolve())
        if target.exists() or target.is_symlink():
            if target.is_symlink():
                # Retiring a development link must also leave a usable code
                # backup, rather than only another pointer to the old checkout.
                shutil.copytree(target, backup / "package-snapshot", symlinks=True,
                                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".git"))
            target.rename(backup / "package")
            replaced = True
        stage.rename(target)
        published = True
        storage.private_write(home / "config.yaml", yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
        return {"installed": True, "plugin": "paper-compare", "home": str(home), "package": str(target), "mode": "development-link" if link else "self-contained-copy", "data": "existing library" if prefs.get("data_dir") else "profile-local library", "credentials": "ForX current profile provider and login", "nodeVersion": version, "backup": str(backup)}
    except BaseException:
        if published:
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
        if replaced and ((backup / "package").exists() or (backup / "package").is_symlink()):
            (backup / "package").rename(target)
        if published or replaced:
            storage.private_write(home / "config.yaml", raw)
        if stage.is_symlink():
            stage.unlink()
        else:
            shutil.rmtree(stage, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--vision-report", type=Path)
    parser.add_argument("--node-path", type=Path)
    parser.add_argument("--skip-deps", action="store_true", help="Copy the package's existing node_modules instead of running npm ci.")
    parser.add_argument("--link", action="store_true", help="Explicit development mode only; normal installs copy the entire package.")
    args = parser.parse_args()
    if args.home is None:
        checkout = ROOT.parents[1]
        if (checkout / "hermes_constants.py").is_file():
            sys.path.insert(0, str(checkout))
        from hermes_constants import get_hermes_home
        args.home = get_hermes_home()
    print(json.dumps(install(args.home, data_dir=args.data_dir, env_file=args.env_file, vision_report=args.vision_report, node_path=args.node_path, skip_deps=args.skip_deps, link=args.link), ensure_ascii=False, indent=2))
