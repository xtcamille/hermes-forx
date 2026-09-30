"""Bundle self-contained Python runtime + site-packages + source into apps/desktop/embedded-backend.

Supports both Windows (win32) and macOS/Linux (POSIX) for local builds and GitHub Actions CI.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
REPO_ROOT = Path(__file__).resolve().parent.parent
TARGET_BACKEND = REPO_ROOT / "apps" / "desktop" / "embedded-backend"

UNPACKED_TARGETS = [
    REPO_ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "backend",
    REPO_ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "resources" / "backend",
]

DIRS_TO_COPY = [
    "agent",
    "cron",
    "gateway",
    "hermes_cli",
    "locales",
    "plugins",
    "providers",
    "skills",
    "tools",
    "tui_gateway",
    "acp_adapter",
]


def resolve_runtime_python_src() -> Path:
    """Locate a standalone CPython 3.11 installation directory across Windows and macOS/Linux."""
    # 1. Explicit environment override
    env_override = os.environ.get("HERMES_RUNTIME_PYTHON_DIR", "").strip()
    if env_override:
        p = Path(env_override).expanduser().resolve()
        if p.is_dir():
            return p

    # 2. Ask `uv python find 3.11 --managed-python` for the portable python-build-standalone install
    uv_bin = shutil.which("uv")
    if uv_bin:
        for cmd in (
            [uv_bin, "python", "find", "3.11", "--managed-python", "--no-config"],
            [uv_bin, "python", "find", "3.11", "--managed-python"],
        ):
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, check=False)
                exe_str = res.stdout.strip()
                if res.returncode == 0 and exe_str and Path(exe_str).is_file():
                    prefix_res = subprocess.run(
                        [exe_str, "-c", "import sys; print(sys.base_prefix)"],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    if prefix_res.returncode == 0 and prefix_res.stdout.strip():
                        prefix_path = Path(prefix_res.stdout.strip()).resolve()
                        if prefix_path.is_dir():
                            return prefix_path
            except Exception:
                pass

    # 3. Check local Hermes runtime directories (.hermes-runtime/python/cpython-3.11*)
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidate_roots = []
    if local_app_data:
        candidate_roots.append(Path(local_app_data) / "hermes" / "hermes-agent" / ".hermes-runtime" / "python")
    candidate_roots.append(Path.home() / ".hermes" / "hermes-agent" / ".hermes-runtime" / "python")

    for root in candidate_roots:
        if root.is_dir():
            matches = sorted(root.glob("cpython-3.11*"), reverse=True)
            for match in matches:
                if match.is_dir():
                    return match.resolve()

    # 4. Fallback to current interpreter's base_prefix
    fallback = Path(sys.base_prefix).resolve()
    if fallback.is_dir():
        return fallback

    raise RuntimeError(
        "Could not locate standalone Python 3.11 runtime. "
        "Run `uv python install 3.11 --managed-python` or set HERMES_RUNTIME_PYTHON_DIR."
    )


def resolve_site_packages_src() -> tuple[Path, str]:
    """Locate the active venv's site-packages directory and return (site_packages_path, py_major_minor)."""
    for venv_name in (".venv", "venv"):
        venv_dir = REPO_ROOT / venv_name
        if not venv_dir.is_dir():
            continue
        if IS_WINDOWS:
            sp = venv_dir / "Lib" / "site-packages"
            if sp.is_dir():
                return sp, "3.11"
        else:
            matches = sorted((venv_dir / "lib").glob("python3.*/site-packages"), reverse=True)
            for sp in matches:
                if sp.is_dir():
                    ver_dir = sp.parent.name  # e.g. "python3.11"
                    ver = ver_dir.replace("python", "") or "3.11"
                    return sp, ver

    raise RuntimeError(
        f"Could not find site-packages under {REPO_ROOT / '.venv'} or {REPO_ROOT / 'venv'}. "
        "Run `uv sync --locked --python 3.11 --extra all` first."
    )


def sync_code_to(target_dir: Path):
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Syncing Python source code to {target_dir}...")
    for d in DIRS_TO_COPY:
        src = REPO_ROOT / d
        if src.is_dir():
            dest = target_dir / d
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(
                src,
                dest,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", ".git*"),
            )

    for f in REPO_ROOT.glob("*.py"):
        shutil.copy2(f, target_dir / f.name)
    for f in ["pyproject.toml", "toolsets.py", "compat_manifest.json", "default_config.yaml"]:
        p = REPO_ROOT / f
        if p.is_file():
            shutil.copy2(p, target_dir / f)
            if f == "default_config.yaml":
                shutil.copy2(p, target_dir / "config.yaml")
                if target_dir.parent.exists():
                    shutil.copy2(p, target_dir.parent / "config.yaml")


def ensure_posix_python_Symlinks(dest_python: Path):
    """Ensure python/bin/python exists and is executable on macOS/Linux."""
    bin_dir = dest_python / "bin"
    target_py = bin_dir / "python"
    if not target_py.exists():
        for cand_name in ("python3", "python3.11"):
            cand = bin_dir / cand_name
            if cand.exists():
                try:
                    target_py.symlink_to(cand_name)
                except OSError:
                    shutil.copy2(cand, target_py)
                break


def main():
    runtime_python_src = resolve_runtime_python_src()
    site_packages_src, py_ver = resolve_site_packages_src()

    print(f"Target backend dir:   {TARGET_BACKEND}")
    print(f"Runtime Python src:   {runtime_python_src}")
    print(f"Site-packages src:    {site_packages_src} (Python {py_ver})")
    TARGET_BACKEND.mkdir(parents=True, exist_ok=True)

    print("1. Syncing Python source packages and modules to embedded backend...")
    sync_code_to(TARGET_BACKEND)

    dest_python = TARGET_BACKEND / "python"
    expected_python_exe = (
        dest_python / "python.exe" if IS_WINDOWS else dest_python / "bin" / "python"
    )
    if not expected_python_exe.exists():
        print("2. Copying standalone Python runtime...")
        if dest_python.exists():
            shutil.rmtree(dest_python)
        shutil.copytree(
            runtime_python_src,
            dest_python,
            symlinks=not IS_WINDOWS,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
        )
        if not IS_WINDOWS:
            ensure_posix_python_Symlinks(dest_python)
            # Ensure no stray pyvenv.cfg inside standalone python/ breaks relocatability
            stray_cfg = dest_python / "pyvenv.cfg"
            if stray_cfg.exists():
                stray_cfg.unlink()
        print(f"   -> Python runtime copied to {dest_python}")
    else:
        print(f"2. Standalone Python runtime already present at {dest_python}")

    if IS_WINDOWS:
        dest_site_packages = TARGET_BACKEND / "venv" / "Lib" / "site-packages"
    else:
        dest_site_packages = TARGET_BACKEND / "venv" / "lib" / f"python{py_ver}" / "site-packages"

    if not dest_site_packages.exists():
        print("3. Copying site-packages...")
        dest_site_packages.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            site_packages_src,
            dest_site_packages,
            symlinks=not IS_WINDOWS,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.dist-info/RECORD"),
        )
        print(f"   -> site-packages copied to {dest_site_packages}")
    else:
        print(f"3. Site-packages already present at {dest_site_packages}")

    if IS_WINDOWS:
        (TARGET_BACKEND / "venv" / "Scripts").mkdir(parents=True, exist_ok=True)
    else:
        (TARGET_BACKEND / "venv" / "bin").mkdir(parents=True, exist_ok=True)
        # getVenvSitePackagesEntries in windows-hermes-path.ts reads venv/pyvenv.cfg
        # on POSIX to determine `lib/python<version>/site-packages`.
        venv_cfg = TARGET_BACKEND / "venv" / "pyvenv.cfg"
        venv_cfg.write_text(
            f"implementation = CPython\nversion_info = {py_ver}.0\ninclude-system-site-packages = false\n",
            encoding="utf-8",
        )

    print("4. Verifying embedded backend runnable...")
    python_exe = expected_python_exe
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([str(TARGET_BACKEND), str(dest_site_packages)])
    res = subprocess.run(
        [str(python_exe), "-m", "hermes_cli.main", "--version"],
        env=env,
        capture_output=True,
        text=True,
    )
    print("Verification result:")
    print("STDOUT:", res.stdout.strip())
    if res.stderr:
        print("STDERR:", res.stderr.strip())
    if res.returncode == 0:
        print("SUCCESS! Embedded backend is completely self-contained and verified!")
    else:
        print("FAILED with code", res.returncode)
        sys.exit(res.returncode)

    if IS_WINDOWS:
        print("5. Syncing to unpacked release directories (if present)...")
        for unpacked in UNPACKED_TARGETS:
            if unpacked.parent.exists():
                print(f"   -> Syncing to {unpacked}...")
                sync_code_to(unpacked)
                unpacked_python = unpacked / "python"
                if not (unpacked_python / "python.exe").exists():
                    print(f"      Copying python runtime to {unpacked_python}...")
                    if unpacked_python.exists():
                        shutil.rmtree(unpacked_python)
                    shutil.copytree(dest_python, unpacked_python)
                unpacked_site_packages = unpacked / "venv" / "Lib" / "site-packages"
                if not unpacked_site_packages.exists():
                    print(f"      Copying site-packages to {unpacked_site_packages}...")
                    unpacked_site_packages.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(dest_site_packages, unpacked_site_packages)
                (unpacked / "venv" / "Scripts").mkdir(parents=True, exist_ok=True)
                print(f"   -> Successfully synced to {unpacked}")


if __name__ == "__main__":
    main()
