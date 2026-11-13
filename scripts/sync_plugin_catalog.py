#!/usr/bin/env python3
"""Sync plugin-catalog entries with their upstream GitHub repositories.

Checks entries in ``plugin-catalog/*.yaml`` against the HEAD commit of their
upstream git repositories. When an upstream repository has moved forward:
1. Clones the new commit in a temporary directory.
2. Extracts updated manifest metadata (version, description, capabilities).
3. Updates the ``plugin-catalog/<name>.yaml`` entry in place.

Usage:
    python scripts/sync_plugin_catalog.py [--name <plugin-name>] [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_DIR = REPO_ROOT / "plugin-catalog"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _run_cmd(cmd: List[str], timeout: int = 30, cwd: Optional[Path] = None) -> Tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def get_remote_head_sha(repo_url: str) -> Optional[str]:
    """Query the remote git repository for HEAD commit SHA via git ls-remote."""
    code, stdout, stderr = _run_cmd(["git", "ls-remote", repo_url, "HEAD"], timeout=20)
    if code != 0 or not stdout:
        return None
    parts = stdout.split()
    if parts and SHA_RE.match(parts[0]):
        return parts[0]
    return None


def read_catalog_entry(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if isinstance(data, dict) else None
    except Exception:
        return None


def write_catalog_entry(path: Path, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


def extract_manifest_from_clone(clone_dir: Path, subdir: str = "") -> Optional[Dict[str, Any]]:
    target = (clone_dir / subdir) if subdir else clone_dir
    manifest_file = next((f for f in (target / "plugin.yaml", target / "plugin.yml") if f.is_file()), None)
    if manifest_file:
        try:
            with open(manifest_file, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
                return data if isinstance(data, dict) else None
        except Exception:
            pass

    json_file = target / "plugin.json"
    if json_file.is_file():
        try:
            import json
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else None
        except Exception:
            pass
    return None


def sync_entry(entry_file: Path, dry_run: bool = False) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Check and optionally sync a single catalog entry file.
    
    Returns (updated, message, details).
    """
    entry = read_catalog_entry(entry_file)
    if not entry or not entry.get("name") or not entry.get("repo") or not entry.get("sha"):
        return False, f"Invalid catalog entry {entry_file.name}", None

    name = entry["name"]
    repo_url = entry["repo"]
    current_sha = entry["sha"].strip().lower()
    subdir = (entry.get("subdir") or "").strip()

    # Skip self-referencing repository to avoid recursive loop in monorepo
    if "xtcamille/hermes-forx" in repo_url.lower() and subdir.startswith("plugins/"):
        return False, f"Skipping monorepo plugin '{name}'", None

    remote_sha = get_remote_head_sha(repo_url)
    if not remote_sha:
        return False, f"Could not fetch remote HEAD for '{name}' ({repo_url})", None

    remote_sha = remote_sha.strip().lower()
    if remote_sha == current_sha:
        return False, f"'{name}' is already at latest commit ({current_sha[:8]})", None

    # Update available! Fetch new commit to inspect manifest
    with tempfile.TemporaryDirectory(prefix="catalog-sync-") as tmp:
        tmp_path = Path(tmp) / "checkout"
        code, _, err = _run_cmd(["git", "clone", "--depth", "1", repo_url, str(tmp_path)], timeout=60)
        if code != 0:
            return False, f"Failed to clone {repo_url} for '{name}': {err}", None

        manifest = extract_manifest_from_clone(tmp_path, subdir) or {}

        # Update entry fields safely
        old_version = entry.get("version", "")
        new_version = str(manifest.get("version") or old_version or "").strip()

        entry["sha"] = remote_sha
        if new_version:
            entry["version"] = new_version
        if manifest.get("description") and len(manifest["description"]) > 5:
            entry["description"] = manifest["description"].strip()

        # Update capabilities if declared
        if "provides_tools" in manifest or "capabilities" in manifest:
            caps = entry.get("capabilities") or {}
            if "provides_tools" in manifest:
                caps["provides_tools"] = list(manifest.get("provides_tools") or [])
            if "provides_hooks" in manifest:
                caps["provides_hooks"] = list(manifest.get("provides_hooks") or [])
            entry["capabilities"] = caps

    details = {
        "name": name,
        "old_sha": current_sha,
        "new_sha": remote_sha,
        "old_version": old_version,
        "new_version": new_version,
    }

    if not dry_run:
        write_catalog_entry(entry_file, entry)

    msg = f"Updated '{name}': {current_sha[:8]} -> {remote_sha[:8]}"
    if old_version != new_version and new_version:
        msg += f" (v{old_version} -> v{new_version})"
    return True, msg, details


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync plugin-catalog entries with upstream repos")
    parser.add_argument("--name", help="Specific plugin name to sync (omitted for all)")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without modifying files")
    parser.add_argument("--output-summary", help="Path to write GitHub Actions summary text")
    args = parser.parse_args()

    if not CATALOG_DIR.is_dir():
        print(f"Error: Catalog directory {CATALOG_DIR} not found", file=sys.stderr)
        sys.exit(1)

    if args.name:
        candidates = [CATALOG_DIR / f"{args.name}.yaml"]
        if not candidates[0].is_file():
            print(f"Error: Plugin catalog file {candidates[0]} does not exist", file=sys.stderr)
            sys.exit(1)
    else:
        candidates = sorted(
            [f for f in CATALOG_DIR.glob("*.yaml") if f.name != "removed.yaml"],
            key=lambda p: p.name,
        )

    updated_list: List[Dict[str, Any]] = []
    print(f"Checking {len(candidates)} plugin catalog entries for upstream updates...")

    for f in candidates:
        updated, msg, details = sync_entry(f, dry_run=args.dry_run)
        prefix = "  [UPDATE]" if updated else "  [OK]"
        print(f"{prefix} {msg}")
        if updated and details:
            updated_list.append(details)

    print()
    print(f"Finished check: {len(updated_list)} plugin(s) updated.")

    if args.output_summary and updated_list:
        try:
            with open(args.output_summary, "w", encoding="utf-8") as out:
                out.write("### 🔄 Plugin Catalog Sync Results\n\n")
                out.write("| Plugin | Previous SHA | Updated SHA | Version |\n")
                out.write("| --- | --- | --- | --- |\n")
                for item in updated_list:
                    v_str = item.get("new_version") or "—"
                    out.write(f"| `{item['name']}` | `{item['old_sha'][:8]}` | `{item['new_sha'][:8]}` | `{v_str}` |\n")
                out.write("\n_Auto-synced from upstream repository HEAD commits._\n")
        except Exception as e:
            print(f"Failed to write summary: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
