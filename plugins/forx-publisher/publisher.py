"""Core publishing engine for forx-publisher.

Handles pre-publish inspection, safety validation, Git metadata extraction,
and automated GitHub PR submission for both Plugins and Skills.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import subprocess
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
import yaml

from hermes_cli._subprocess_compat import windows_hide_flags
from hermes_constants import display_hermes_home
from hermes_cli.plugin_validate import validate_plugin_dir
from tools.skills_guard import scan_skill, format_scan_report
from tools.skills_hub_github import GitHubAuth

logger = logging.getLogger("forx_publisher")

DEFAULT_TARGET_REPO = "xtcamille/hermes-forx"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
NAME_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
GITHUB_HTTP_RE = re.compile(r"^https://github\.com/([^/\s]+)/([^/\s#?]+?)(?:\.git)?/?$")
GITHUB_SSH_RE = re.compile(r"^git@github\.com:([^/\s]+)/([^/\s#?]+?)(?:\.git)?/?$")


def normalize_github_url(raw_url: str) -> str:
    """Normalize GitHub git or web URLs to standard https://github.com/owner/repo format."""
    raw = (raw_url or "").strip()
    m_ssh = GITHUB_SSH_RE.match(raw)
    if m_ssh:
        return f"https://github.com/{m_ssh.group(1)}/{m_ssh.group(2)}"
    m_http = GITHUB_HTTP_RE.match(raw)
    if m_http:
        return f"https://github.com/{m_http.group(1)}/{m_http.group(2)}"
    return raw.rstrip("/").removesuffix(".git")


def _run_git_cmd(args: List[str], cwd: Path) -> Tuple[int, str]:
    """Execute git command cleanly with windows hidden window flags."""
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            creationflags=windows_hide_flags(),
        )
        return proc.returncode, proc.stdout.strip()
    except Exception as exc:
        return 1, str(exc)


def detect_git_metadata(directory: Path) -> Dict[str, Any]:
    """Inspect local git repository for remote origin URL, HEAD commit SHA, and dirty status."""
    meta: Dict[str, Any] = {
        "is_git_repo": False,
        "remote_url": "",
        "commit_sha": "",
        "branch": "",
        "is_dirty": False,
        "uncommitted_files": [],
        "warnings": [],
    }

    code, out = _run_git_cmd(["git", "rev-parse", "--is-inside-work-tree"], directory)
    if code != 0 or out.lower() != "true":
        meta["warnings"].append("Directory is not inside a git repository.")
        return meta

    meta["is_git_repo"] = True

    # Current branch
    _, branch = _run_git_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], directory)
    meta["branch"] = branch

    # Commit SHA
    code_sha, sha = _run_git_cmd(["git", "rev-parse", "HEAD"], directory)
    if code_sha == 0 and SHA_RE.match(sha):
        meta["commit_sha"] = sha
    else:
        meta["warnings"].append("Could not resolve valid 40-character HEAD commit SHA.")

    # Remote origin URL
    code_remote, remote = _run_git_cmd(["git", "config", "--get", "remote.origin.url"], directory)
    if code_remote == 0 and remote:
        meta["remote_url"] = normalize_github_url(remote)
    else:
        meta["warnings"].append("No remote.origin.url found. Has this repo been pushed to GitHub?")

    # Dirty status
    code_st, st = _run_git_cmd(["git", "status", "--porcelain"], directory)
    if code_st == 0 and st:
        meta["is_dirty"] = True
        dirty_lines = [l.strip() for l in st.splitlines() if l.strip()]
        meta["uncommitted_files"] = dirty_lines[:10]
        meta["warnings"].append(
            f"Working directory has {len(dirty_lines)} uncommitted change(s). "
            "Make sure your latest changes are committed and pushed before publishing!"
        )

    return meta


def get_auth_status(auth: Optional[GitHubAuth] = None) -> Dict[str, Any]:
    """Check GitHub authentication status, resolved user, and credentials info."""
    authenticator = auth or GitHubAuth()
    is_authed = authenticator.is_authenticated()
    method = authenticator.auth_method()

    status: Dict[str, Any] = {
        "authenticated": is_authed,
        "method": method,
        "username": None,
        "error": None,
    }

    if not is_authed:
        status["error"] = (
            f"未检测到 GitHub 认证凭据。请在 {display_hermes_home()}/.env 中设置 GITHUB_TOKEN "
            "或在终端运行 'gh auth login' 完成授权。"
        )
        return status

    # Query authenticated user from GitHub API
    try:
        headers = authenticator.get_headers()
        resp = httpx.get("https://api.github.com/user", headers=headers, timeout=10)
        if resp.status_code == 200:
            user_data = resp.json()
            status["username"] = user_data.get("login")
        elif resp.status_code == 401:
            status["authenticated"] = False
            status["error"] = "GitHub Token 无效或已过期，请重新配置。"
        else:
            status["error"] = f"查询 GitHub 用户信息返回状态码 {resp.status_code}"
    except Exception as exc:
        logger.debug("Failed to query github user info: %s", exc)
        status["error"] = f"网络请求失败: {exc}"

    return status


def _read_skill_frontmatter(content: str) -> Dict[str, Any]:
    """Parse YAML frontmatter from SKILL.md."""
    if not content.startswith("---"):
        return {}
    m = re.search(r"\n---\s*(?:\n|$)", content[3:])
    if not m:
        return {}
    try:
        return yaml.safe_load(content[3:m.start() + 3]) or {}
    except Exception:
        return {}


def check_target(path: str | Path, target_type: str = "auto") -> Dict[str, Any]:
    """Inspect and validate a target plugin or skill directory.

    target_type: 'auto', 'plugin', or 'skill'
    """
    target = Path(path).resolve()
    if not target.exists():
        return {
            "ok": False,
            "target_type": target_type,
            "path": str(target),
            "error": f"Path does not exist: {target}",
        }

    # Auto-detect kind
    detected_type = target_type
    if detected_type == "auto":
        if (target / "plugin.yaml").exists() or (target / "plugin.yml").exists() or (target / "plugin.json").exists():
            detected_type = "plugin"
        elif (target / "SKILL.md").exists():
            detected_type = "skill"
        else:
            # Check if any parent or child has plugin.yaml or SKILL.md
            if (target / "__init__.py").exists():
                detected_type = "plugin"
            else:
                return {
                    "ok": False,
                    "target_type": "unknown",
                    "path": str(target),
                    "error": (
                        f"Could not determine target type for '{target.name}'. "
                        "A plugin must contain 'plugin.yaml' and a skill must contain 'SKILL.md'."
                    ),
                }

    if detected_type == "plugin":
        return _check_plugin(target)
    elif detected_type == "skill":
        return _check_skill(target)
    else:
        return {
            "ok": False,
            "target_type": detected_type,
            "path": str(target),
            "error": f"Unsupported target_type: {detected_type}",
        }


def _check_plugin(target: Path) -> Dict[str, Any]:
    """Run full admission validation and git inspection on a plugin directory."""
    report = validate_plugin_dir(target)
    git_meta = detect_git_metadata(target)

    # Read manifest metadata
    manifest_file = next((f for f in (target / "plugin.yaml", target / "plugin.yml") if f.exists()), None)
    manifest_data: Dict[str, Any] = {}
    if manifest_file:
        try:
            manifest_data = yaml.safe_load(manifest_file.read_text(encoding="utf-8")) or {}
        except Exception:
            pass

    name = manifest_data.get("name") or target.name
    description = manifest_data.get("description") or ""
    version = str(manifest_data.get("version") or "0.1.0")
    maintainer = manifest_data.get("author") or manifest_data.get("maintainer") or ""
    category = manifest_data.get("category") or "tools"

    # Capability extraction
    if manifest_data.get("provides_tools"):
        provides_tools = list(manifest_data.get("provides_tools") or [])
    elif isinstance(manifest_data.get("capabilities"), list):
        provides_tools = [
            c.replace("tool:", "") for c in manifest_data["capabilities"] if "tool" in c
        ]
    elif isinstance(manifest_data.get("capabilities"), dict):
        provides_tools = list(manifest_data["capabilities"].get("provides_tools") or [])
    else:
        provides_tools = []

    if manifest_data.get("provides_hooks") or manifest_data.get("hooks"):
        provides_hooks = list(manifest_data.get("provides_hooks") or manifest_data.get("hooks") or [])
    elif isinstance(manifest_data.get("capabilities"), dict):
        provides_hooks = list(manifest_data["capabilities"].get("provides_hooks") or [])
    else:
        provides_hooks = []

    provides_middleware = list(
        manifest_data.get("provides_middleware")
        or (manifest_data.get("capabilities", {}).get("provides_middleware") if isinstance(manifest_data.get("capabilities"), dict) else [])
        or []
    )
    requires_env = list(
        manifest_data.get("requires_env")
        or (manifest_data.get("capabilities", {}).get("requires_env") if isinstance(manifest_data.get("capabilities"), dict) else [])
        or []
    )

    # Catalog preview
    catalog_preview: Dict[str, Any] = {
        "name": name,
        "repo": git_meta.get("remote_url") or "https://github.com/your-username/" + name,
        "sha": git_meta.get("commit_sha") or ("0" * 40),
        "description": description,
        "maintainer": maintainer or "YourName",
        "tier": "community",
        "category": category,
        "version": version,
        "capabilities": {
            "provides_tools": provides_tools,
            "provides_hooks": provides_hooks,
            "provides_middleware": provides_middleware,
            "requires_env": requires_env,
        },
    }

    catalog_yaml_preview = yaml.safe_dump(catalog_preview, sort_keys=False, allow_unicode=True)

    return {
        "ok": report.ok,
        "target_type": "plugin",
        "path": str(target),
        "name": name,
        "version": version,
        "description": description,
        "maintainer": maintainer,
        "category": category,
        "validation": {
            "passed": report.ok,
            "failures": report.failures,
            "warnings": report.warnings,
            "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in report.checks],
        },
        "git": git_meta,
        "catalog_preview": catalog_preview,
        "catalog_yaml_preview": catalog_yaml_preview,
    }


def _check_skill(target: Path) -> Dict[str, Any]:
    """Run structure check, frontmatter parsing, and skills_guard security scan on a skill directory."""
    skill_md_path = target / "SKILL.md"
    if not skill_md_path.exists():
        return {
            "ok": False,
            "target_type": "skill",
            "path": str(target),
            "error": f"SKILL.md not found in {target}",
        }

    raw_text = skill_md_path.read_text(encoding="utf-8").lstrip("\ufeff")
    fm = _read_skill_frontmatter(raw_text)
    name = fm.get("name") or target.name
    description = fm.get("description") or ""

    if not description:
        return {
            "ok": False,
            "target_type": "skill",
            "path": str(target),
            "error": "SKILL.md frontmatter must contain a non-empty 'description'.",
        }

    # Run skills_guard scan
    scan_res = scan_skill(target, source="self")
    verdict = scan_res.verdict
    report_text = format_scan_report(scan_res)

    is_safe = verdict in ("safe", "clean", "caution")
    can_publish = verdict != "dangerous"

    findings_list = [
        {
            "pattern_id": getattr(f, "pattern_id", ""),
            "severity": getattr(f, "severity", ""),
            "description": getattr(f, "description", ""),
            "file": getattr(f, "file", ""),
            "line": getattr(f, "line", 0),
        }
        for f in getattr(scan_res, "findings", [])
    ]

    return {
        "ok": can_publish,
        "target_type": "skill",
        "path": str(target),
        "name": name,
        "description": description,
        "verdict": verdict,
        "can_publish": can_publish,
        "scan_report": report_text,
        "findings": findings_list,
        "frontmatter": fm,
    }


def generate_catalog_yaml(
    name: str,
    repo_url: str,
    commit_sha: str,
    description: str,
    maintainer: str,
    category: str = "tools",
    version: str = "0.1.0",
    subdir: str = "",
    capabilities: Optional[Dict[str, Any]] = None,
    requires_hermes: str = "",
    platforms: Optional[List[str]] = None,
) -> str:
    """Generate compliant plugin-catalog YAML string."""
    name_clean = name.strip().lower()
    if not NAME_RE.match(name_clean):
        raise ValueError(f"Invalid plugin name {name!r}: must match ^[a-z0-9_-]{{1,64}}$")
    if not SHA_RE.match(commit_sha):
        raise ValueError(f"Invalid commit SHA {commit_sha!r}: must be an exact 40-character hex string.")
    if not repo_url.startswith("https://"):
        raise ValueError(f"Invalid repo URL {repo_url!r}: must start with https://")

    caps = capabilities or {}
    data: Dict[str, Any] = {
        "name": name_clean,
        "repo": repo_url.rstrip("/"),
        "sha": commit_sha,
        "description": description.strip(),
        "maintainer": maintainer.strip() or "Community Contributor",
        "tier": "community",
        "category": category if category in ("desktop", "memory", "platform", "web", "tools", "voice", "automation", "models", "general") else "tools",
    }
    if subdir:
        data["subdir"] = subdir
    if version:
        data["version"] = str(version)
    if requires_hermes:
        data["requires_hermes"] = requires_hermes
    if platforms:
        data["platforms"] = platforms

    data["capabilities"] = {
        "provides_tools": list(caps.get("provides_tools", [])),
        "provides_hooks": list(caps.get("provides_hooks", [])),
        "provides_middleware": list(caps.get("provides_middleware", [])),
        "requires_env": list(caps.get("requires_env", [])),
    }

    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True)


class GitHubPRClient:
    """Handles GitHub API operations: Forking, Branching, File Creation, and PR Opening."""

    def __init__(self, auth: GitHubAuth):
        self.auth = auth
        self.headers = auth.get_headers()
        self.api = "https://api.github.com"

    def _call(self, method: str, path: str, timeout: int = 20, **kwargs) -> httpx.Response:
        url = f"{self.api}/{path.lstrip('/')}"
        return getattr(httpx, method)(url, headers=self.headers, timeout=timeout, **kwargs)

    def get_authenticated_user(self) -> str:
        resp = self._call("get", "user")
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to get user login: HTTP {resp.status_code} {resp.text[:100]}")
        return resp.json()["login"]

    def fork_repository(self, target_repo: str) -> str:
        """Fork target repository and return 'owner/repo' of the fork."""
        resp = self._call("post", f"repos/{target_repo}/forks", timeout=30)
        if resp.status_code in (200, 202):
            fork_full_name = resp.json().get("full_name")
            return fork_full_name
        elif resp.status_code == 403:
            raise PermissionError("GitHub Token 权限不足，无法执行 Fork 操作。请确保 Token 包含 'repo' 或 'public_repo' 权限。")
        else:
            raise RuntimeError(f"Fork {target_repo} 失败: HTTP {resp.status_code} {resp.text[:200]}")

    def get_default_branch_sha(self, target_repo: str) -> Tuple[str, str]:
        """Fetch default branch name and its latest commit SHA."""
        resp = self._call("get", f"repos/{target_repo}")
        if resp.status_code != 200:
            raise RuntimeError(f"获取仓库 {target_repo} 信息失败: {resp.status_code}")
        default_branch = resp.json().get("default_branch", "main")

        ref_resp = self._call("get", f"repos/{target_repo}/git/refs/heads/{default_branch}")
        if ref_resp.status_code != 200:
            raise RuntimeError(f"获取分支 {default_branch} SHA 失败: {ref_resp.status_code}")
        base_sha = ref_resp.json()["object"]["sha"]
        return default_branch, base_sha

    def create_branch(self, fork_repo: str, branch_name: str, base_sha: str) -> None:
        """Create a new git ref/branch on the fork."""
        payload = {"ref": f"refs/heads/{branch_name}", "sha": base_sha}
        resp = self._call("post", f"repos/{fork_repo}/git/refs", json=payload)
        if resp.status_code == 422:
            # Branch might already exist, try fetching or ignore
            logger.debug("Branch %s might already exist on %s", branch_name, fork_repo)
            return
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"在 {fork_repo} 创建分支 {branch_name} 失败: {resp.status_code} {resp.text[:150]}")

    def put_file(self, fork_repo: str, path_in_repo: str, content_bytes: bytes, branch: str, message: str) -> None:
        """Create or update a file in the branch."""
        b64 = base64.b64encode(content_bytes).decode("ascii")
        payload: Dict[str, Any] = {
            "message": message,
            "content": b64,
            "branch": branch,
        }
        # Check if file exists to provide sha if updating
        get_res = self._call("get", f"repos/{fork_repo}/contents/{path_in_repo}?ref={branch}")
        if get_res.status_code == 200:
            payload["sha"] = get_res.json().get("sha")

        resp = self._call("put", f"repos/{fork_repo}/contents/{path_in_repo}", json=payload)
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"上传文件 {path_in_repo} 失败: {resp.status_code} {resp.text[:200]}")

    def open_pull_request(self, target_repo: str, fork_owner: str, branch: str, title: str, body: str, base_branch: str) -> Dict[str, Any]:
        """Create a Pull Request from fork:branch to target_repo:base_branch."""
        payload = {
            "title": title,
            "body": body,
            "head": f"{fork_owner}:{branch}",
            "base": base_branch,
        }
        resp = self._call("post", f"repos/{target_repo}/pulls", json=payload)
        if resp.status_code == 201:
            data = resp.json()
            return {
                "ok": True,
                "pr_url": data.get("html_url"),
                "pr_number": data.get("number"),
                "title": data.get("title"),
            }
        else:
            raise RuntimeError(f"创建 Pull Request 失败: HTTP {resp.status_code} {resp.text[:300]}")


def publish_skill(
    path: str | Path,
    target_repo: str = DEFAULT_TARGET_REPO,
    skill_name: str = "",
    dest_dir: str = "optional-skills",
    dry_run: bool = False,
    auth: Optional[GitHubAuth] = None,
) -> Dict[str, Any]:
    """Publish a local skill by scanning it and submitting a PR to target_repo."""
    target_path = Path(path).resolve()
    check_res = check_target(target_path, target_type="skill")
    if not check_res.get("ok"):
        return {
            "ok": False,
            "error": f"Skill validation failed: {check_res.get('error') or check_res.get('verdict')}",
            "check": check_res,
        }

    name = skill_name or check_res["name"]
    description = check_res["description"]
    verdict = check_res.get("verdict", "safe")

    if dry_run:
        files = [str(f.relative_to(target_path)) for f in target_path.rglob("*") if f.is_file()]
        return {
            "ok": True,
            "dry_run": True,
            "name": name,
            "target_repo": target_repo,
            "destination_path": f"{dest_dir}/{name}/",
            "files_to_upload": files,
            "verdict": verdict,
            "message": "Dry-run completed successfully. All pre-flight safety checks passed.",
        }

    authenticator = auth or GitHubAuth()
    if not authenticator.is_authenticated():
        return {
            "ok": False,
            "error": (
                "GitHub authentication required to publish.\n"
                f"Please set GITHUB_TOKEN in {display_hermes_home()}/.env or run 'gh auth login'."
            ),
        }

    client = GitHubPRClient(authenticator)
    try:
        current_user = client.get_authenticated_user()
        logger.info("Publishing skill '%s' to %s as user '%s'...", name, target_repo, current_user)

        fork_full_name = client.fork_repository(target_repo)
        # Allow fork to register
        time.sleep(1.5)

        default_branch, base_sha = client.get_default_branch_sha(target_repo)
        ts = int(time.time())
        branch_name = f"add-skill-{name}-{ts}"
        client.create_branch(fork_full_name, branch_name, base_sha)

        # Upload files
        uploaded_files = []
        for file_path in target_path.rglob("*"):
            if not file_path.is_file():
                continue
            rel = str(file_path.relative_to(target_path)).replace("\\", "/")
            repo_file_path = f"{dest_dir}/{name}/{rel}"
            client.put_file(
                fork_repo=fork_full_name,
                path_in_repo=repo_file_path,
                content_bytes=file_path.read_bytes(),
                branch=branch_name,
                message=f"Add skill {name}: {rel}",
            )
            uploaded_files.append(repo_file_path)

        pr_title = f"Add skill: {name}"
        pr_body = (
            f"### 🚀 New Skill Submission: `{name}`\n\n"
            f"**Description:** {description}\n\n"
            f"**Skills Guard Security Scan:**\n"
            f"- Verdict: `{verdict}`\n"
            f"- Scanned Files: {len(uploaded_files)}\n\n"
            f"Submitted from client via `forx-publisher` plugin."
        )

        pr_res = client.open_pull_request(
            target_repo=target_repo,
            fork_owner=current_user,
            branch=branch_name,
            title=pr_title,
            body=pr_body,
            base_branch=default_branch,
        )

        return {
            "ok": True,
            "dry_run": False,
            "name": name,
            "pr_url": pr_res["pr_url"],
            "pr_number": pr_res["pr_number"],
            "uploaded_files": uploaded_files,
            "message": f"Successfully created Pull Request: {pr_res['pr_url']}",
        }

    except Exception as exc:
        logger.exception("Error publishing skill: %s", exc)
        return {
            "ok": False,
            "error": str(exc),
        }


def publish_plugin(
    path: str | Path,
    repo_url: str = "",
    commit_sha: str = "",
    target_repo: str = DEFAULT_TARGET_REPO,
    category: str = "tools",
    maintainer: str = "",
    dry_run: bool = False,
    auth: Optional[GitHubAuth] = None,
) -> Dict[str, Any]:
    """Publish a local plugin by validating it, generating catalog entry, and submitting PR to plugin-catalog/."""
    target_path = Path(path).resolve()
    check_res = check_target(target_path, target_type="plugin")

    # If critical validation failed
    if not check_res.get("ok"):
        failures = check_res.get("validation", {}).get("failures", [])
        return {
            "ok": False,
            "error": f"Plugin validation checks failed: {'; '.join(failures)}",
            "check": check_res,
        }

    git_meta = check_res.get("git", {})
    resolved_repo = (repo_url or git_meta.get("remote_url") or "").strip()
    resolved_sha = (commit_sha or git_meta.get("commit_sha") or "").strip()

    if not resolved_repo or not resolved_repo.startswith("https://"):
        return {
            "ok": False,
            "error": (
                "A public HTTPS git repository URL is required to list in the Plugin Catalog.\n"
                "Please push your plugin to GitHub and supply --repo-url https://github.com/owner/repo"
            ),
            "check": check_res,
        }

    if not resolved_sha or not SHA_RE.match(resolved_sha):
        return {
            "ok": False,
            "error": (
                "An exact 40-character commit SHA is required to pin the catalog entry.\n"
                "Please commit your latest changes and supply --commit-sha <40-hex-sha>"
            ),
            "check": check_res,
        }

    name = check_res["name"]
    description = check_res["description"]
    version = check_res["version"]
    resolved_maintainer = maintainer or check_res.get("maintainer") or "Community Contributor"
    resolved_category = category or check_res.get("category") or "tools"

    # Construct catalog YAML
    caps = check_res.get("catalog_preview", {}).get("capabilities", {})
    try:
        catalog_yaml_content = generate_catalog_yaml(
            name=name,
            repo_url=resolved_repo,
            commit_sha=resolved_sha,
            description=description,
            maintainer=resolved_maintainer,
            category=resolved_category,
            version=version,
            capabilities=caps,
        )
    except Exception as exc:
        return {
            "ok": False,
            "error": f"Failed to generate catalog entry YAML: {exc}",
        }

    catalog_entry_path = f"plugin-catalog/{name}.yaml"

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "name": name,
            "target_repo": target_repo,
            "catalog_entry_path": catalog_entry_path,
            "catalog_yaml": catalog_yaml_content,
            "git_info": {
                "repo": resolved_repo,
                "sha": resolved_sha,
            },
            "message": "Dry-run validation successful. Catalog YAML entry generated and verified.",
        }

    authenticator = auth or GitHubAuth()
    if not authenticator.is_authenticated():
        return {
            "ok": False,
            "error": (
                "GitHub authentication required to publish.\n"
                f"Please set GITHUB_TOKEN in {display_hermes_home()}/.env or run 'gh auth login'."
            ),
        }

    client = GitHubPRClient(authenticator)
    try:
        current_user = client.get_authenticated_user()
        logger.info("Publishing plugin '%s' to catalog in %s as user '%s'...", name, target_repo, current_user)

        fork_full_name = client.fork_repository(target_repo)
        time.sleep(1.5)

        default_branch, base_sha = client.get_default_branch_sha(target_repo)
        ts = int(time.time())
        branch_name = f"add-plugin-{name}-{ts}"
        client.create_branch(fork_full_name, branch_name, base_sha)

        # Upload the single catalog YAML entry
        client.put_file(
            fork_repo=fork_full_name,
            path_in_repo=catalog_entry_path,
            content_bytes=catalog_yaml_content.encode("utf-8"),
            branch=branch_name,
            message=f"Add plugin catalog entry: {name}",
        )

        pr_title = f"Add plugin: {name}"
        pr_body = (
            f"### 🔌 New Plugin Catalog Entry: `{name}`\n\n"
            f"**Repository:** {resolved_repo}\n"
            f"**Commit SHA:** `{resolved_sha}`\n"
            f"**Version:** `{version}`\n"
            f"**Maintainer:** {resolved_maintainer}\n"
            f"**Category:** `{resolved_category}`\n\n"
            f"**Description:**\n> {description}\n\n"
            f"**Catalog YAML:**\n```yaml\n{catalog_yaml_content}```\n\n"
            f"Validated and submitted automatically from client via `forx-publisher` plugin."
        )

        pr_res = client.open_pull_request(
            target_repo=target_repo,
            fork_owner=current_user,
            branch=branch_name,
            title=pr_title,
            body=pr_body,
            base_branch=default_branch,
        )

        return {
            "ok": True,
            "dry_run": False,
            "name": name,
            "pr_url": pr_res["pr_url"],
            "pr_number": pr_res["pr_number"],
            "catalog_entry_path": catalog_entry_path,
            "catalog_yaml": catalog_yaml_content,
            "message": f"Successfully opened Catalog Pull Request: {pr_res['pr_url']}",
        }

    except Exception as exc:
        logger.exception("Error publishing plugin: %s", exc)
        return {
            "ok": False,
            "error": str(exc),
        }
