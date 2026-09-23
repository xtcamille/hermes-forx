"""Tests for RAGFlow enterprise knowledge base authentication and retrieval."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict

import httpx

from hermes_cli import auth_ragflow


class FakeRagflowServer:
    def __init__(self):
        self.login_count = 0
        self.dataset_count = 0
        self.retrieval_count = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/auth/login") or path.endswith("/user/login") or path.endswith("/login"):
            self.login_count += 1
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            email = body.get("email") or body.get("username") or ""
            pwd = body.get("password") or ""
            if "nonexistent" in email or "wrong" in pwd:
                return httpx.Response(401, json={"code": 1001, "message": "Invalid password"})
            return httpx.Response(200, json={
                "code": 0,
                "data": {
                    "token": "test_token_ragflow_xyz",
                    "username": email,
                }
            })

        if path.endswith("/datasets") or path.endswith("/dataset"):
            self.dataset_count += 1
            auth_header = request.headers.get("Authorization", "")
            if "test_token" in auth_header:
                return httpx.Response(200, json={
                    "code": 0,
                    "data": [
                        {"id": "kb_test_1", "name": "技术规范库", "document_count": 15, "description": "内部技术标准"},
                        {"id": "kb_test_2", "name": "公司制度与报销", "document_count": 8, "description": "人事与财务规范"}
                    ]
                })
            return httpx.Response(401, json={"code": 1002, "message": "Unauthorized"})

        if path.endswith("/retrieval") or path.endswith("/datasets/search"):
            self.retrieval_count += 1
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            question = body.get("question", "")
            dataset_ids = body.get("dataset_ids", [])
            return httpx.Response(200, json={
                "code": 0,
                "data": {
                    "chunks": [
                        {
                            "content": f"关于 {question} 的报销政策详见本节。",
                            "document_name": "财务报销规范2026.pdf",
                            "dataset_id": dataset_ids[0] if dataset_ids else "kb_test_2",
                            "similarity": 0.88,
                        }
                    ]
                }
            })

        return httpx.Response(404, json={"message": "Not Found"})


def test_normalize_ragflow_url():
    assert auth_ragflow.normalize_ragflow_url("http://172.22.0.87/login") == "http://172.22.0.87"
    assert auth_ragflow.normalize_ragflow_url("http://172.22.0.87/") == "http://172.22.0.87"
    assert auth_ragflow.normalize_ragflow_url("172.22.0.87") == "http://172.22.0.87"
    assert auth_ragflow.normalize_ragflow_url("https://rag.company.com/login/") == "https://rag.company.com"


def test_encrypt_ragflow_password():
    enc = auth_ragflow.encrypt_ragflow_password("my_secret_pass")
    assert enc != "my_secret_pass"
    assert len(enc) > 100


def test_login_and_fetch_datasets(tmp_path=None):
    if tmp_path is None:
        td = tempfile.TemporaryDirectory()
        tmp_path = Path(td.name)
    os.environ["HERMES_HOME"] = str(tmp_path)
    fake = FakeRagflowServer()
    client = httpx.Client(transport=httpx.MockTransport(fake.handler))

    # Test login failure
    failed = False
    try:
        auth_ragflow.login_ragflow(
            username="nonexistent@company.com",
            password="wrong_password",
            base_url="http://172.22.0.87",
            client=client
        )
    except Exception as exc_info:
        failed = True
        assert "Invalid password" in str(exc_info) or "failed" in str(exc_info).lower()
    assert failed is True

    # Test login success
    state = auth_ragflow.login_ragflow(
        username="test@company.com",
        password="correct_pass",
        base_url="http://172.22.0.87",
        client=client
    )
    assert state["access_token"] == "test_token_ragflow_xyz"
    assert state["username"] == "test@company.com"
    assert len(state["cached_datasets"]) == 2
    assert auth_ragflow.is_ragflow_logged_in() is True

    # Test dataset fetch
    datasets = auth_ragflow.fetch_ragflow_datasets(
        base_url="http://172.22.0.87",
        token="test_token_ragflow_xyz",
        client=client
    )
    assert len(datasets) == 2
    assert datasets[0]["name"] == "技术规范库"
    assert datasets[1]["name"] == "公司制度与报销"

    # Test retrieval
    chunks = auth_ragflow.search_ragflow(
        query="差旅发票",
        dataset_ids=["kb_test_2"],
        base_url="http://172.22.0.87",
        token="test_token_ragflow_xyz",
        client=client
    )
    assert len(chunks) == 1
    assert "财务报销规范2026.pdf" in chunks[0]["document_name"]
    assert "差旅发票" in chunks[0]["content"]

    # Test session dataset binding
    auth_ragflow.set_session_active_datasets("session_123", ["kb_test_1"])
    assert auth_ragflow.get_session_active_datasets("session_123") == ["kb_test_1"]

    # Test logout
    auth_ragflow.clear_ragflow_auth_state()
    assert auth_ragflow.is_ragflow_logged_in() is False


if __name__ == "__main__":
    test_normalize_ragflow_url()
    print("test_normalize_ragflow_url passed")
    test_encrypt_ragflow_password()
    print("test_encrypt_ragflow_password passed")
    test_login_and_fetch_datasets()
    print("test_login_and_fetch_datasets passed")
    print("ALL TESTS PASSED!")
