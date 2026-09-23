"""Tests for Enterprise Knowledge Base tools (search_enterprise_kb & list_enterprise_kb)."""

from __future__ import annotations

import json
from unittest.mock import patch

from tools.enterprise_kb_tool import (
    _check_enterprise_kb,
    _handle_list_enterprise_kb,
    _handle_search_enterprise_kb,
)


def test_enterprise_kb_check(monkeypatch):
    with patch("tools.enterprise_kb_tool.is_ragflow_logged_in", return_value=False):
        assert _check_enterprise_kb() is False

    with patch("tools.enterprise_kb_tool.is_ragflow_logged_in", return_value=True):
        assert _check_enterprise_kb() is True


def test_handle_search_enterprise_kb():
    # Test query required
    res_empty = json.loads(_handle_search_enterprise_kb({}))
    assert "query is required" in res_empty.get("error", "")

    # Test successful search
    mock_chunks = [
        {
            "content": "员工年假为每年 10 天。",
            "document_name": "考勤与休假管理办法.docx",
            "similarity": 0.92,
        }
    ]
    with patch("tools.enterprise_kb_tool.search_ragflow", return_value=mock_chunks):
        res = json.loads(_handle_search_enterprise_kb({"query": "年假几天", "dataset_ids": ["kb_1"]}))
        assert res.get("success") is True
        assert res.get("chunk_count") == 1
        assert "考勤与休假管理办法" in res.get("content", "")
        assert "每年 10 天" in res.get("content", "")


def test_handle_list_enterprise_kb():
    mock_datasets = [
        {"id": "kb_1", "name": "研发代码规范", "document_count": 20, "description": "开发标准"},
        {"id": "kb_2", "name": "人事行政制度", "document_count": 5, "description": "行政制度"},
    ]
    with patch("tools.enterprise_kb_tool.fetch_ragflow_datasets", return_value=mock_datasets):
        res = json.loads(_handle_list_enterprise_kb({}))
        assert res.get("success") is True
        assert len(res.get("datasets", [])) == 2
        assert "研发代码规范" in res.get("content", "")
        assert "人事行政制度" in res.get("content", "")
