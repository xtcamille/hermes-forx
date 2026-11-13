#!/usr/bin/env python3
"""Generate release notes for ForX GitHub releases.

Extracts feature introductions and changelog from CHANGELOG.md, manual input,
or git commits between tags, and merges with the installation guide template.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


CONVENTIONAL_CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("🚀 新增功能 / Features", "features", ("feat",)),
    ("🐛 漏洞修复 / Bug Fixes", "fixes", ("fix",)),
    ("⚡ 性能与体验优化 / Performance & UX", "perf", ("perf", "ui", "ux")),
    ("🔧 架构维护与依赖更新 / Maintenance", "maintenance", ("chore", "refactor", "build", "ci")),
    ("📝 文档更新 / Documentation", "docs", ("docs",)),
]


def clean_version(ver: str) -> str:
    """Normalize version string by stripping leading 'v'."""
    return ver.strip().lstrip("v")


def extract_notes_from_changelog(changelog_path: Path, ver: str) -> str:
    """Extract markdown content for a given version from CHANGELOG.md."""
    if not changelog_path.is_file():
        return ""

    try:
        content = changelog_path.read_text(encoding="utf-8")
    except Exception as exc:
        print(f"Warning: could not read {changelog_path}: {exc}", file=sys.stderr)
        return ""

    clean_ver = clean_version(ver)
    header_pattern = re.compile(
        rf"^##\s+\[?v?{re.escape(clean_ver)}\]?(?:\s+[-–—]\s+[^\n]*)?$",
        re.MULTILINE | re.IGNORECASE,
    )

    match = header_pattern.search(content)
    if not match:
        return ""

    start_pos = match.end()
    next_header_pattern = re.compile(r"^##\s+", re.MULTILINE)
    next_match = next_header_pattern.search(content, pos=start_pos)

    if next_match:
        section = content[start_pos:next_match.start()]
    else:
        section = content[start_pos:]

    # Clean up leading/trailing whitespace and trailing separators
    lines = section.strip().splitlines()
    while lines and lines[-1].strip() in ("---", "___", "***", ""):
        lines.pop()

    return "\n".join(lines).strip()


def get_git_commits_since_last_tag(current_ref: str = "HEAD") -> list[tuple[str, str]]:
    """Return list of (sha, subject) commits between previous tag and current ref."""
    try:
        cmd_prev = ["git", "describe", "--tags", "--abbrev=0", f"{current_ref}^"]
        res = subprocess.run(cmd_prev, capture_output=True, text=True, check=False)
        prev_tag = res.stdout.strip()
    except Exception:
        prev_tag = ""

    if not prev_tag:
        try:
            res_tags = subprocess.run(
                ["git", "tag", "--sort=-v:refname"],
                capture_output=True,
                text=True,
                check=False,
            )
            tags = [t.strip() for t in res_tags.stdout.splitlines() if t.strip()]
            for t in tags:
                if t != current_ref and f"v{clean_version(t)}" != f"v{clean_version(current_ref)}":
                    prev_tag = t
                    break
        except Exception:
            prev_tag = ""

    log_range = f"{prev_tag}..{current_ref}" if prev_tag else current_ref
    try:
        cmd_log = ["git", "log", log_range, "--pretty=format:%h|%s"]
        res_log = subprocess.run(cmd_log, capture_output=True, text=True, check=False)
        commits: list[tuple[str, str]] = []
        for line in res_log.stdout.splitlines():
            if "|" in line:
                sha, subject = line.split("|", 1)
                commits.append((sha.strip(), subject.strip()))
        return commits
    except Exception as exc:
        print(f"Warning: git log failed: {exc}", file=sys.stderr)
        return []


def format_commits_by_category(commits: list[tuple[str, str]]) -> str:
    """Group commits into conventional categories with markdown formatting."""
    if not commits:
        return ""

    grouped: dict[str, list[tuple[str, str]]] = {cat_id: [] for _, cat_id, _ in CONVENTIONAL_CATEGORIES}
    grouped["other"] = []

    for sha, subject in commits:
        matched = False
        conv_match = re.match(r"^([a-zA-Z]+)(?:\([^)]+\))?!?:", subject)
        if conv_match:
            prefix = conv_match.group(1).lower()
            for _, cat_id, prefixes in CONVENTIONAL_CATEGORIES:
                if prefix in prefixes:
                    grouped[cat_id].append((sha, subject))
                    matched = True
                    break
        if not matched:
            grouped["other"].append((sha, subject))

    lines: list[str] = []
    for title, cat_id, _ in CONVENTIONAL_CATEGORIES:
        items = grouped[cat_id]
        if items:
            lines.append(f"### {title}")
            for sha, subj in items:
                lines.append(f"- {subj} (`{sha}`)")
            lines.append("")

    if grouped["other"]:
        lines.append("### 📋 其他更新 / Other Changes")
        for sha, subj in grouped["other"]:
            lines.append(f"- {subj} (`{sha}`)")
        lines.append("")

    return "\n".join(lines).strip()


def build_release_notes(
    version: str,
    template_path: Path,
    changelog_path: Path | None = None,
    custom_notes: str = "",
    current_ref: str = "HEAD",
) -> str:
    """Combine feature introduction with the installation template."""
    clean_ver = clean_version(version)
    tag_ver = f"v{clean_ver}"

    # 1. Resolve feature introduction
    notes = custom_notes.strip()
    commits = get_git_commits_since_last_tag(current_ref)

    if not notes and changelog_path:
        notes = extract_notes_from_changelog(changelog_path, clean_ver)

    if not notes and commits:
        notes = format_commits_by_category(commits)

    if not notes:
        notes = f"ForX Desktop {tag_ver} 包含常规改进、性能优化与体验升级。"

    # 2. Resolve template
    template_content = ""
    if template_path.is_file():
        template_content = template_path.read_text(encoding="utf-8")
        template_content = template_content.replace("__VER__", clean_ver).strip()
        while template_content.endswith("---"):
            template_content = template_content[:-3].rstrip()

    # 3. Assemble document
    sections: list[str] = [
        f"## 🚀 本次更新介绍 / What's New ({tag_ver})",
        "",
        notes,
        "",
        "---",
        "",
    ]
    if template_content:
        sections.append(template_content)

    # 4. Optional collapsed commit log when commits exist and notes were from CHANGELOG
    if commits:
        commit_list = "\n".join(f"- {subj} (`{sha}`)" for sha, subj in commits)
        sections.extend([
            "",
            "---",
            "",
            "<details>",
            "<summary><b>📜 详细提交记录 / Detailed Commit Log</b></summary>",
            "",
            commit_list,
            "",
            "</details>",
        ])

    return "\n".join(sections).strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate release notes for ForX.")
    parser.add_argument("--version", "-v", required=True, help="Release version (e.g. 0.1.20 or v0.1.20)")
    parser.add_argument("--template", "-t", default=".github/release_notes_template.md", help="Path to template")
    parser.add_argument("--changelog", "-c", default="CHANGELOG.md", help="Path to CHANGELOG.md")
    parser.add_argument("--notes", "-n", default="", help="Custom release notes override")
    parser.add_argument("--ref", default="HEAD", help="Current git ref for commit range fallback")
    parser.add_argument("--output", "-o", default="release_notes.md", help="Output file path")

    args = parser.parse_args()

    template_file = Path(args.template)
    changelog_file = Path(args.changelog) if args.changelog else None
    output_file = Path(args.output)

    notes = build_release_notes(
        version=args.version,
        template_path=template_file,
        changelog_path=changelog_file,
        custom_notes=args.notes,
        current_ref=args.ref,
    )

    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(notes, encoding="utf-8")
    print(f"Generated release notes for {args.version} -> {output_file}")


if __name__ == "__main__":
    main()
