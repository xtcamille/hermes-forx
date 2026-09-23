"""Enterprise Knowledge Base (RAGFlow) native tools for Hermes Agent."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from hermes_cli.auth_ragflow import (
    fetch_ragflow_datasets,
    get_ragflow_auth_state,
    get_session_active_datasets,
    is_ragflow_logged_in,
    search_ragflow,
)
from tools.registry import no_cache_check_fn, registry, tool_error, tool_result

logger = logging.getLogger("tools.enterprise_kb")

SEARCH_ENTERPRISE_KB_SCHEMA = {
    "name": "search_enterprise_kb",
    "description": (
        "Search the enterprise knowledge base (RAGFlow) for relevant documents, manuals, and specifications. "
        "Returns the most relevant text chunks from the authorized knowledge bases."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query or question to retrieve enterprise knowledge for.",
            },
            "dataset_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional list of dataset IDs to search in. If omitted, uses the datasets selected for this session or all accessible datasets.",
            },
            "top_k": {
                "type": "integer",
                "description": "Maximum number of relevant chunks to retrieve (default: 6).",
                "default": 6,
            },
        },
        "required": ["query"],
    },
}

LIST_ENTERPRISE_KB_SCHEMA = {
    "name": "list_enterprise_kb",
    "description": "List all accessible enterprise knowledge bases (datasets) and their document counts for the currently logged in account.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}


@no_cache_check_fn
def _check_enterprise_kb() -> bool:
    """True if enterprise knowledge base is logged in and configured."""
    return is_ragflow_logged_in()


def _handle_search_enterprise_kb(args: dict, **kwargs) -> str:
    """Handle searching the enterprise knowledge base."""
    query = str(args.get("query", "")).strip()
    if not query:
        return tool_error("query is required")

    session_id = kwargs.get("session_id")
    allowed_ids = get_session_active_datasets(session_id)

    if not allowed_ids:
        return tool_result(
            success=True,
            content="No enterprise knowledge base datasets are selected or active for this conversation. "
                    "The user has not selected or enabled any knowledge base datasets. "
                    "Do not attempt to search; please answer the user's question directly using your general knowledge, "
                    "or inform the user that they can select a knowledge base from the chat controls if they want to query internal documents."
        )

    requested_ids = args.get("dataset_ids")
    if requested_ids and isinstance(requested_ids, list):
        dataset_ids = [str(x) for x in requested_ids if str(x) in allowed_ids]
        if not dataset_ids:
            return tool_result(
                success=True,
                content=f"The requested dataset ID(s) {requested_ids} are not selected or enabled for this conversation. "
                        f"Active dataset(s) for this session: {allowed_ids}. "
                        "Do not search unselected datasets. Please answer based on your general knowledge or using only the active datasets."
            )
    else:
        dataset_ids = allowed_ids

    top_k = int(args.get("top_k") or 6)

    try:
        chunks = search_ragflow(query, dataset_ids=dataset_ids, top_k=top_k)
    except Exception as exc:
        logger.warning("Enterprise KB search failed: %s", exc)
        return tool_error(f"Enterprise knowledge base search failed: {exc}")

    if not chunks:
        target_hint = f"in specified datasets ({len(dataset_ids)} selected)" if dataset_ids else "in enterprise knowledge base"
        return tool_result(success=True, content=f"No relevant document content found {target_hint} for query: '{query}'.")

    formatted_parts: List[str] = []
    for i, c in enumerate(chunks, 1):
        doc = c.get("document_name", "Unknown Document")
        score = c.get("similarity", 0.0)
        content = c.get("content", "").strip()
        score_str = f" (similarity: {score:.2f})" if score > 0 else ""
        formatted_parts.append(f"### [{i}] 《{doc}》{score_str}\n{content}")

    result_text = "\n\n---\n\n".join(formatted_parts)
    return tool_result(success=True, content=result_text, chunk_count=len(chunks))


def _handle_list_enterprise_kb(args: dict, **kwargs) -> str:
    """Handle listing available enterprise knowledge bases."""
    try:
        datasets = fetch_ragflow_datasets()
    except Exception as exc:
        return tool_error(f"Failed to fetch enterprise knowledge base list: {exc}")

    if not datasets:
        return tool_result(success=True, content="No knowledge bases found for current account.", datasets=[])

    session_id = kwargs.get("session_id")
    active_ids = set(get_session_active_datasets(session_id))

    lines = [f"Found {len(datasets)} accessible enterprise knowledge base(s):"]
    for d in datasets:
        is_active = str(d.get("id")) in active_ids
        status_tag = "[ACTIVE in this session]" if is_active else "[NOT SELECTED in this session - DO NOT SEARCH]"
        lines.append(f"- **{d['name']}** (ID: `{d['id']}`, Documents: {d['document_count']}) {status_tag}")
        if d.get("description"):
            lines.append(f"  *Description*: {d['description']}")

    return tool_result(success=True, content="\n".join(lines), datasets=datasets)


registry.register(
    name="search_enterprise_kb",
    toolset="enterprise_kb",
    schema=SEARCH_ENTERPRISE_KB_SCHEMA,
    handler=_handle_search_enterprise_kb,
    check_fn=_check_enterprise_kb,
    requires_env=[],
    is_async=False,
    description="Search enterprise knowledge base (RAGFlow)",
    emoji="\U0001f4da",
)

registry.register(
    name="list_enterprise_kb",
    toolset="enterprise_kb",
    schema=LIST_ENTERPRISE_KB_SCHEMA,
    handler=_handle_list_enterprise_kb,
    check_fn=_check_enterprise_kb,
    requires_env=[],
    is_async=False,
    description="List accessible enterprise knowledge bases (RAGFlow)",
    emoji="\U0001f4da",
)
