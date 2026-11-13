from pathlib import Path
import tempfile
import pytest

from scripts.generate_release_notes import (
    clean_version,
    extract_notes_from_changelog,
    format_commits_by_category,
    build_release_notes,
)


def test_clean_version():
    assert clean_version("v1.2.3") == "1.2.3"
    assert clean_version("1.2.3") == "1.2.3"
    assert clean_version(" v0.1.20 ") == "0.1.20"


def test_extract_notes_from_changelog():
    sample = """# Changelog

## [v0.1.20] - 2026-11-13
### 🚀 Features
- New feature A
- New feature B

---

## [v0.1.19] - 2026-10-10
### 🐛 Fixes
- Old fix
"""
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".md") as f:
        f.write(sample)
        f_path = Path(f.name)

    try:
        notes = extract_notes_from_changelog(f_path, "0.1.20")
        assert "### 🚀 Features" in notes
        assert "- New feature A" in notes
        assert "v0.1.19" not in notes
        assert "Old fix" not in notes

        # Non-existent version
        assert extract_notes_from_changelog(f_path, "0.1.99") == ""
    finally:
        f_path.unlink(missing_ok=True)


def test_format_commits_by_category():
    commits = [
        ("abc1234", "feat(plugins): add new plugin UI"),
        ("def5678", "fix(catalog): resolve cache issue"),
        ("1234567", "chore: bump dependencies"),
        ("89abcde", "something else without prefix"),
    ]
    formatted = format_commits_by_category(commits)
    assert "### 🚀 新增功能 / Features" in formatted
    assert "feat(plugins): add new plugin UI (`abc1234`)" in formatted
    assert "### 🐛 漏洞修复 / Bug Fixes" in formatted
    assert "fix(catalog): resolve cache issue (`def5678`)" in formatted
    assert "### 🔧 架构维护与依赖更新 / Maintenance" in formatted
    assert "### 📋 其他更新 / Other Changes" in formatted


def test_build_release_notes_with_changelog_and_template():
    with tempfile.TemporaryDirectory() as tmpdir:
        t_dir = Path(tmpdir)
        template_file = t_dir / "template.md"
        template_file.write_text("### Downloads\nFile: ForX-__VER__-win.exe\n---\n", encoding="utf-8")

        changelog_file = t_dir / "CHANGELOG.md"
        changelog_file.write_text(
            "## [v0.2.0] - 2026-11-13\n- Feature X\n---\n## [v0.1.0]\n- Old\n",
            encoding="utf-8",
        )

        output = build_release_notes(
            version="0.2.0",
            template_path=template_file,
            changelog_path=changelog_file,
            current_ref="HEAD",
        )

        assert "## 🚀 本次更新介绍 / What's New (v0.2.0)" in output
        assert "- Feature X" in output
        assert "File: ForX-0.2.0-win.exe" in output


def test_build_release_notes_custom_notes_override():
    with tempfile.TemporaryDirectory() as tmpdir:
        t_dir = Path(tmpdir)
        template_file = t_dir / "template.md"
        template_file.write_text("### Downloads\nFile: ForX-__VER__.exe", encoding="utf-8")

        output = build_release_notes(
            version="0.3.0",
            template_path=template_file,
            custom_notes="Manual custom notes content",
            current_ref="HEAD",
        )

        assert "Manual custom notes content" in output
        assert "File: ForX-0.3.0.exe" in output
