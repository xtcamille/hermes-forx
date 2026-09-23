"""Bundle embedded backend into apps/desktop/release/win-unpacked/backend."""

import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path("d:/hermes-forx").resolve()
TARGET_BACKEND = REPO_ROOT / "apps" / "desktop" / "embedded-backend"
UNPACKED_TARGETS = [
    REPO_ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "backend",
    REPO_ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "resources" / "backend",
]
RUNTIME_PYTHON_SRC = Path(
    "C:/Users/ZXT/AppData/Local/hermes/hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-x86_64-none"
)
SITE_PACKAGES_SRC = REPO_ROOT / ".venv" / "Lib" / "site-packages"

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

def sync_code_to(target_dir: Path):
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"Syncing Python source code to {target_dir}...")
    for d in DIRS_TO_COPY:
        src = REPO_ROOT / d
        if src.is_dir():
            dest = target_dir / d
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", ".git*"))

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

def main():
    print(f"Target backend dir: {TARGET_BACKEND}")
    TARGET_BACKEND.mkdir(parents=True, exist_ok=True)

    print("1. Syncing Python source packages and modules to embedded backend...")
    sync_code_to(TARGET_BACKEND)

    dest_python = TARGET_BACKEND / "python"
    if not (dest_python / "python.exe").exists():
        print("2. Copying standalone Python runtime...")
        if dest_python.exists():
            shutil.rmtree(dest_python)
        shutil.copytree(RUNTIME_PYTHON_SRC, dest_python, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
        print(f"   -> Python runtime copied to {dest_python}")
    else:
        print(f"2. Standalone Python runtime already present at {dest_python}")

    dest_site_packages = TARGET_BACKEND / "venv" / "Lib" / "site-packages"
    if not dest_site_packages.exists():
        print("3. Copying site-packages...")
        dest_site_packages.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            SITE_PACKAGES_SRC,
            dest_site_packages,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", "*.dist-info/RECORD")
        )
        print(f"   -> site-packages copied to {dest_site_packages}")
    else:
        print(f"3. Site-packages already present at {dest_site_packages}")

    # Create dummy empty Scripts dir in venv so venvRootForPython finds it if needed, but no python stub
    (TARGET_BACKEND / "venv" / "Scripts").mkdir(parents=True, exist_ok=True)

    print("4. Verifying embedded backend runnable...")
    python_exe = dest_python / "python.exe"
    import subprocess
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{TARGET_BACKEND};{dest_site_packages}"
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

    print("5. Syncing to unpacked release directories...")
    for unpacked in UNPACKED_TARGETS:
        if unpacked.parent.exists():
            print(f"   -> Syncing to {unpacked}...")
            sync_code_to(unpacked)
            # Ensure runtime and venv exist in unpacked as well
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
