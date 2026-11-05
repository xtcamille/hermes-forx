"""Context analysis and token accounting core for forx-context plugin.

Extracts context window breakdowns, token expenditures, capacity utilization,
step-by-step turn evolution, and tool usage across Hermes/ForX sessions.
"""
from __future__ import annotations

import json
import logging
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from agent.model_metadata import (
    CHARS_PER_TOKEN,
    estimate_tokens_rough,
    get_model_context_length,
)
from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
from hermes_constants import get_hermes_home
from hermes_state import SessionDB

logger = logging.getLogger(__name__)

USD_TO_CNY_RATE = 7.23


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val) if val is not None else default
    except (ValueError, TypeError):
        return default


def _safe_int(val: Any, default: int = 0) -> int:
    try:
        return int(val) if val is not None else default
    except (ValueError, TypeError):
        return default


def _estimate_model_cost_fallback(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
) -> float:
    """Benchmark pricing for popular models when not in official pricing table (e.g. Qwen, GLM, DeepSeek)."""
    m = (model or "").lower()
    # Rates per 1,000,000 tokens (USD)
    if "flash" in m or "mini" in m or "free" in m:
        inp_rate, out_rate, cache_rate = 0.05, 0.15, 0.01
    elif "qwen" in m:
        if "72b" in m:
            inp_rate, out_rate, cache_rate = 0.35, 0.70, 0.05
        elif "27b" in m or "32b" in m or "5090" in m:
            inp_rate, out_rate, cache_rate = 0.18, 0.36, 0.03
        else:
            inp_rate, out_rate, cache_rate = 0.10, 0.20, 0.02
    elif "glm" in m:
        if "flash" in m:
            inp_rate, out_rate, cache_rate = 0.01, 0.01, 0.005
        else:
            inp_rate, out_rate, cache_rate = 0.15, 0.15, 0.03
    elif "deepseek" in m:
        inp_rate, out_rate, cache_rate = 0.14, 0.28, 0.014
    elif "llama" in m:
        if "70b" in m:
            inp_rate, out_rate, cache_rate = 0.35, 0.70, 0.05
        else:
            inp_rate, out_rate, cache_rate = 0.10, 0.20, 0.02
    elif "gpt-4o" in m:
        inp_rate, out_rate, cache_rate = 2.50, 10.00, 1.25
    elif "claude" in m:
        inp_rate, out_rate, cache_rate = 3.00, 15.00, 0.30
    else:
        inp_rate, out_rate, cache_rate = 0.15, 0.30, 0.02

    cost = (
        (input_tokens * inp_rate / 1_000_000.0)
        + (output_tokens * out_rate / 1_000_000.0)
        + (cache_read_tokens * cache_rate / 1_000_000.0)
    )
    return max(0.0, cost)


def _calculate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    provider: Optional[str] = None,
    base_url: Optional[str] = None,
) -> float:
    """Estimate USD cost using Hermes pricing table with intelligent benchmark fallback."""
    try:
        usage = CanonicalUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
        )
        res = estimate_usage_cost(model or "", usage, provider=provider, base_url=base_url)
        if res.amount_usd is not None and float(res.amount_usd) > 0.0:
            return float(res.amount_usd)
    except Exception:
        pass
    return _estimate_model_cost_fallback(model, input_tokens, output_tokens, cache_read_tokens)


def _parse_system_prompt_sections(system_prompt: str) -> Dict[str, Any]:
    """Breakdown system prompt into identity, skills, tools schema, and memory sections."""
    if not system_prompt:
        return {
            "total_tokens": 0,
            "identity_tokens": 0,
            "skills_tokens": 0,
            "tools_tokens": 0,
            "memory_tokens": 0,
            "other_tokens": 0,
        }

    total_tokens = estimate_tokens_rough(system_prompt)

    # 1. Skills section detection (<skills>...</skills> or Available skills:)
    skills_text = ""
    skills_match = re.search(r"<skills>.*?</skills>", system_prompt, re.DOTALL)
    if skills_match:
        skills_text = skills_match.group(0)
    elif "Available skills:" in system_prompt:
        parts = system_prompt.split("Available skills:", 1)
        skills_text = parts[1][:4000]

    # 2. Memory section detection (<memory>...</memory> or Memory:)
    memory_text = ""
    memory_match = re.search(r"<memory>.*?</memory>", system_prompt, re.DOTALL)
    if memory_match:
        memory_text = memory_match.group(0)

    # 3. Tools definitions section detection (<tools>...</tools> or tool declarations)
    tools_text = ""
    tools_match = re.search(r"<tools>.*?</tools>", system_prompt, re.DOTALL)
    if tools_match:
        tools_text = tools_match.group(0)

    skills_tokens = estimate_tokens_rough(skills_text)
    memory_tokens = estimate_tokens_rough(memory_text)
    tools_tokens = estimate_tokens_rough(tools_text)

    # If tools_tokens not in system prompt (Hermes sends tools via API function calling),
    # baseline default tools schema overhead is around 1200 tokens
    estimated_tools_schema_tokens = tools_tokens if tools_tokens > 0 else 1250

    sub_tokens = skills_tokens + memory_tokens + tools_tokens
    identity_tokens = max(0, total_tokens - sub_tokens)

    return {
        "total_tokens": total_tokens + (1250 if tools_tokens == 0 else 0),
        "identity_tokens": identity_tokens,
        "skills_tokens": skills_tokens,
        "tools_tokens": estimated_tools_schema_tokens,
        "memory_tokens": memory_tokens,
        "other_tokens": max(0, total_tokens - identity_tokens - skills_tokens - memory_tokens),
    }


def analyze_session_context(
    session_id: str,
    profile: Optional[str] = None,
) -> Dict[str, Any]:
    """Analyze single session context breakdown, tokens, cost, capacity, and step evolution."""
    from hermes_cli.web_server_profiles import _config_profile_scope

    with _config_profile_scope(profile):
        db = SessionDB(read_only=True)
        try:
            resolved_id = db.resolve_session_id(session_id) or session_id
            session = db.get_session(resolved_id)
            if not session:
                return {
                    "ok": False,
                    "error": f"Session '{session_id}' not found",
                }

            model = session.get("model") or "hermes"
            context_limit = get_model_context_length(model) or 128000
            system_prompt = session.get("system_prompt") or ""

            sys_breakdown = _parse_system_prompt_sections(system_prompt)

            # Retrieve messages (both active and compacted)
            all_messages = db.get_messages(resolved_id, include_inactive=True, include_compacted=True)
            active_messages = [m for m in all_messages if m.get("active") == 1]
            compacted_messages = [m for m in all_messages if m.get("compacted") == 1 or m.get("active") == 0]

            # Categorize message tokens
            user_tokens = 0
            assistant_tokens = 0
            reasoning_tokens_acc = 0
            tool_call_tokens = 0
            tool_result_tokens = 0
            compacted_tokens = 0

            # Tool usage metrics
            tool_stats: Dict[str, Dict[str, Any]] = defaultdict(
                lambda: {"calls": 0, "errors": 0, "tokens": 0}
            )

            # Build step-by-step evolution timeline
            timeline: List[Dict[str, Any]] = []
            cumulative_active = sys_breakdown["total_tokens"]

            for idx, msg in enumerate(all_messages, start=1):
                role = msg.get("role", "unknown")
                content = msg.get("content") or ""
                t_count = msg.get("token_count")
                if not t_count or t_count <= 0:
                    t_count = estimate_tokens_rough(content)

                is_active = (msg.get("active") == 1)
                is_compacted = (msg.get("compacted") == 1 or not is_active)

                tool_calls_data = msg.get("tool_calls")
                if isinstance(tool_calls_data, str):
                    try:
                        tool_calls_data = json.loads(tool_calls_data)
                    except Exception:
                        tool_calls_data = None

                tool_name = msg.get("tool_name")
                if not tool_name and isinstance(tool_calls_data, list) and len(tool_calls_data) > 0:
                    first_fn = tool_calls_data[0].get("function") or {}
                    tool_name = first_fn.get("name")

                # Accumulate tokens by category
                if is_compacted:
                    compacted_tokens += t_count
                else:
                    if role == "user":
                        user_tokens += t_count
                    elif role == "assistant":
                        r_content = msg.get("reasoning_content") or msg.get("reasoning") or ""
                        r_tokens = estimate_tokens_rough(r_content) if r_content else 0
                        reasoning_tokens_acc += r_tokens
                        assistant_tokens += t_count
                    elif role == "tool":
                        tool_result_tokens += t_count

                    if tool_calls_data:
                        call_toks = estimate_tokens_rough(str(tool_calls_data))
                        tool_call_tokens += call_toks

                    cumulative_active += t_count

                # Record tool stats
                if role == "tool" and tool_name:
                    tool_stats[tool_name]["calls"] += 1
                    tool_stats[tool_name]["tokens"] += t_count
                    if "error" in content.lower() or "exception" in content.lower():
                        tool_stats[tool_name]["errors"] += 1
                elif isinstance(tool_calls_data, list):
                    for tc in tool_calls_data:
                        fn = tc.get("function") or {}
                        fn_name = fn.get("name")
                        if fn_name:
                            tool_stats[fn_name]["calls"] += 1
                            args_str = fn.get("arguments") or ""
                            tool_stats[fn_name]["tokens"] += estimate_tokens_rough(str(args_str))

                # Timeline item
                preview = content.strip().replace("\n", " ")
                if len(preview) > 60:
                    preview = preview[:57] + "..."
                if not preview and tool_name:
                    preview = f"call: {tool_name}"

                timeline.append({
                    "step": idx,
                    "id": msg.get("id"),
                    "role": role,
                    "preview": preview,
                    "tokens": t_count,
                    "cumulative_tokens": cumulative_active if is_active else None,
                    "is_active": is_active,
                    "is_compacted": is_compacted,
                    "tool_name": tool_name,
                    "timestamp": msg.get("timestamp"),
                })

            active_tokens_total = (
                sys_breakdown["total_tokens"]
                + user_tokens
                + assistant_tokens
                + tool_call_tokens
                + tool_result_tokens
            )

            usage_pct = round((active_tokens_total / max(1, context_limit)) * 100, 1)
            health_status = (
                "safe" if usage_pct < 65.0
                else ("caution" if usage_pct < 85.0 else "critical")
            )

            # Token and cost accounting from DB
            input_tokens = _safe_int(session.get("input_tokens"))
            output_tokens = _safe_int(session.get("output_tokens"))
            cache_read_tokens = _safe_int(session.get("cache_read_tokens"))
            cache_write_tokens = _safe_int(session.get("cache_write_tokens"))
            reasoning_tokens = _safe_int(session.get("reasoning_tokens"), reasoning_tokens_acc)

            stored_cost = _safe_float(session.get("actual_cost_usd") or session.get("estimated_cost_usd"))
            if stored_cost <= 0.0 and (input_tokens > 0 or output_tokens > 0):
                cost_usd = _calculate_cost(
                    model,
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    provider=session.get("billing_provider"),
                    base_url=session.get("billing_base_url"),
                )
            else:
                cost_usd = stored_cost

            total_tokens = input_tokens + output_tokens + cache_read_tokens
            cache_hit_rate = (
                round((cache_read_tokens / max(1, input_tokens + cache_read_tokens)) * 100, 1)
            )

            # Breakdown segments for visual stacked bar / donut chart
            breakdown_segments = [
                {
                    "key": "identity",
                    "label": "系统设定与身份 (System & Identity)",
                    "tokens": sys_breakdown["identity_tokens"],
                    "color": "#3b82f6",  # blue
                },
                {
                    "key": "skills",
                    "label": "加载技能与指引 (Skills & Instructions)",
                    "tokens": sys_breakdown["skills_tokens"],
                    "color": "#8b5cf6",  # purple
                },
                {
                    "key": "tools_schema",
                    "label": "工具契约 (Tools Schema)",
                    "tokens": sys_breakdown["tools_tokens"],
                    "color": "#06b6d4",  # cyan
                },
                {
                    "key": "memory",
                    "label": "长期记忆 (Memory Context)",
                    "tokens": sys_breakdown["memory_tokens"],
                    "color": "#10b981",  # emerald
                },
                {
                    "key": "user",
                    "label": "用户提示 (User Messages)",
                    "tokens": user_tokens,
                    "color": "#f59e0b",  # amber
                },
                {
                    "key": "assistant",
                    "label": "助手回复与思考 (Assistant & Reasoning)",
                    "tokens": assistant_tokens,
                    "color": "#ec4899",  # pink
                },
                {
                    "key": "tool_results",
                    "label": "工具执行产物 (Tool Calls & Outputs)",
                    "tokens": tool_call_tokens + tool_result_tokens,
                    "color": "#14b8a6",  # teal
                },
            ]

            # Filter out segments with 0 tokens for visual clarity
            active_segments = [s for s in breakdown_segments if s["tokens"] > 0]

            return {
                "ok": True,
                "session": {
                    "id": resolved_id,
                    "title": session.get("title") or "未命名会话",
                    "model": model,
                    "started_at": session.get("started_at"),
                    "ended_at": session.get("ended_at"),
                    "message_count": len(all_messages),
                    "active_message_count": len(active_messages),
                    "compacted_message_count": len(compacted_messages),
                    "tool_call_count": session.get("tool_call_count") or sum(t["calls"] for t in tool_stats.values()),
                },
                "capacity": {
                    "active_tokens": active_tokens_total,
                    "context_limit": context_limit,
                    "usage_pct": usage_pct,
                    "remaining_tokens": max(0, context_limit - active_tokens_total),
                    "health_status": health_status,  # "safe" | "caution" | "critical"
                    "compacted_tokens": compacted_tokens,
                },
                "tokens": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_tokens": cache_read_tokens,
                    "cache_write_tokens": cache_write_tokens,
                    "reasoning_tokens": reasoning_tokens,
                    "total_tokens": total_tokens,
                    "cache_hit_rate": cache_hit_rate,
                },
                "cost": {
                    "cost_usd": round(cost_usd, 5),
                    "cost_cny": round(cost_usd * USD_TO_CNY_RATE, 4),
                    "cost_status": session.get("cost_status") or "estimated",
                },
                "breakdown": {
                    "system": sys_breakdown,
                    "user_tokens": user_tokens,
                    "assistant_tokens": assistant_tokens,
                    "tool_call_tokens": tool_call_tokens,
                    "tool_result_tokens": tool_result_tokens,
                    "compacted_tokens": compacted_tokens,
                    "segments": active_segments,
                },
                "tools": [
                    {
                        "name": name,
                        "calls": st["calls"],
                        "errors": st["errors"],
                        "tokens": st["tokens"],
                    }
                    for name, st in sorted(tool_stats.items(), key=lambda x: x[1]["calls"], reverse=True)
                ],
                "timeline": timeline,
            }
        finally:
            db.close()


def get_fleet_context_overview(
    profile: Optional[str] = None,
    days: int = 7,
) -> Dict[str, Any]:
    """Retrieve multi-session overview, KPI aggregates, daily trends and activity heatmap."""
    from hermes_cli.web_server_profiles import _config_profile_scope

    with _config_profile_scope(profile):
        db = SessionDB(read_only=True)
        try:
            # Query sessions rich list
            sessions = db.list_sessions_rich(limit=200, offset=0, compact_rows=False) or []

            now = time.time()
            cutoff_seconds = now - (days * 86400)

            total_sessions = len(sessions)
            total_input = 0
            total_output = 0
            total_cache_read = 0
            total_cost_usd = 0.0

            status_counts = {"safe": 0, "caution": 0, "critical": 0}

            # Daily trend buckets (last `days` days)
            daily_buckets: Dict[str, Dict[str, Any]] = {}
            for i in range(days - 1, -1, -1):
                dt_str = (datetime.fromtimestamp(now) - timedelta(days=i)).strftime("%Y-%m-%d")
                daily_buckets[dt_str] = {
                    "date": dt_str,
                    "sessions": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "total_tokens": 0,
                    "cost_usd": 0.0,
                }

            # 8-week heatmap buckets (56 days)
            heatmap_buckets: Dict[str, Dict[str, Any]] = {}
            for i in range(55, -1, -1):
                dt_str = (datetime.fromtimestamp(now) - timedelta(days=i)).strftime("%Y-%m-%d")
                heatmap_buckets[dt_str] = {
                    "date": dt_str,
                    "sessions": 0,
                    "tokens": 0,
                    "cost_usd": 0.0,
                    "level": 0,
                }

            session_cards = []

            # Model and Provider breakdown aggregates
            model_aggregates: Dict[str, Dict[str, Any]] = defaultdict(
                lambda: {
                    "model": "",
                    "provider": "",
                    "sessions": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "total_tokens": 0,
                    "cost_usd": 0.0,
                    "is_free_tier": False,
                }
            )
            provider_aggregates: Dict[str, Dict[str, Any]] = defaultdict(
                lambda: {
                    "provider": "",
                    "display_name": "",
                    "sessions": 0,
                    "total_tokens": 0,
                    "cost_usd": 0.0,
                    "models": set(),
                    "is_free_tier": False,
                }
            )

            for s in sessions:
                sid = s.get("id")
                model = s.get("model") or "hermes"
                inp = _safe_int(s.get("input_tokens"))
                out = _safe_int(s.get("output_tokens"))
                cread = _safe_int(s.get("cache_read_tokens"))
                cost = _safe_float(s.get("actual_cost_usd") or s.get("estimated_cost_usd"))
                provider = s.get("billing_provider") or "latticecode"

                # Calculate estimated cost fallback when DB has no cost recorded
                if cost <= 0.0 and (inp > 0 or out > 0):
                    cost = _calculate_cost(
                        model,
                        inp,
                        out,
                        cread,
                        provider=provider,
                        base_url=s.get("billing_base_url"),
                    )

                total_input += inp
                total_output += out
                total_cache_read += cread
                total_cost_usd += cost

                # Aggregate by model
                m_agg = model_aggregates[model]
                m_agg["model"] = model
                m_agg["provider"] = provider
                m_agg["sessions"] += 1
                m_agg["input_tokens"] += inp
                m_agg["output_tokens"] += out
                m_agg["cache_read_tokens"] += cread
                m_agg["total_tokens"] += (inp + out + cread)
                m_agg["cost_usd"] += cost
                if provider in ("latticecode", "free_tier") or "free" in model.lower():
                    m_agg["is_free_tier"] = True

                # Aggregate by provider
                p_agg = provider_aggregates[provider]
                p_agg["provider"] = provider
                p_agg["display_name"] = "ForX New API (LatticeCode)" if provider in ("latticecode", "free_tier") else provider
                p_agg["sessions"] += 1
                p_agg["total_tokens"] += (inp + out + cread)
                p_agg["cost_usd"] += cost
                p_agg["models"].add(model)
                if provider in ("latticecode", "free_tier"):
                    p_agg["is_free_tier"] = True

                started = _safe_float(s.get("started_at"), now)
                dt_key = datetime.fromtimestamp(started).strftime("%Y-%m-%d")

                if dt_key in daily_buckets:
                    daily_buckets[dt_key]["sessions"] += 1
                    daily_buckets[dt_key]["input_tokens"] += inp
                    daily_buckets[dt_key]["output_tokens"] += out
                    daily_buckets[dt_key]["cache_read_tokens"] += cread
                    daily_buckets[dt_key]["total_tokens"] += (inp + out + cread)
                    daily_buckets[dt_key]["cost_usd"] += cost

                if dt_key in heatmap_buckets:
                    heatmap_buckets[dt_key]["sessions"] += 1
                    heatmap_buckets[dt_key]["tokens"] += (inp + out + cread)
                    heatmap_buckets[dt_key]["cost_usd"] += cost

                # Capacity calculation for card
                limit = get_model_context_length(model) or 128000
                active_toks = inp + out
                pct = round((active_toks / max(1, limit)) * 100, 1)
                status = "safe" if pct < 65.0 else ("caution" if pct < 85.0 else "critical")
                status_counts[status] += 1

                if len(session_cards) < 40:
                    session_cards.append({
                        "id": sid,
                        "title": s.get("title") or "未命名会话",
                        "model": model,
                        "provider": provider,
                        "started_at": started,
                        "message_count": s.get("message_count") or 0,
                        "active_tokens": active_toks,
                        "context_limit": limit,
                        "usage_pct": pct,
                        "health_status": status,
                        "cost_usd": round(cost, 5),
                    })

            # Calculate heatmap levels (0..4) based on token quantiles
            all_tok_vals = [h["tokens"] for h in heatmap_buckets.values() if h["tokens"] > 0]
            max_heat = max(all_tok_vals) if all_tok_vals else 1

            for h in heatmap_buckets.values():
                t = h["tokens"]
                if t <= 0:
                    h["level"] = 0
                elif t < max_heat * 0.25:
                    h["level"] = 1
                elif t < max_heat * 0.5:
                    h["level"] = 2
                elif t < max_heat * 0.75:
                    h["level"] = 3
                else:
                    h["level"] = 4

            total_all_tokens = total_input + total_output + total_cache_read
            avg_cache_hit_rate = (
                round((total_cache_read / max(1, total_input + total_cache_read)) * 100, 1)
            )

            # Format models breakdown
            models_list = []
            for m_name, m_data in sorted(model_aggregates.items(), key=lambda x: x[1]["total_tokens"], reverse=True):
                pct = round((m_data["total_tokens"] / max(1, total_all_tokens)) * 100, 1)
                models_list.append({
                    "model": m_name,
                    "provider": m_data["provider"],
                    "sessions": m_data["sessions"],
                    "input_tokens": m_data["input_tokens"],
                    "output_tokens": m_data["output_tokens"],
                    "cache_read_tokens": m_data["cache_read_tokens"],
                    "total_tokens": m_data["total_tokens"],
                    "percentage": pct,
                    "cost_usd": round(m_data["cost_usd"], 4),
                    "cost_cny": round(m_data["cost_usd"] * USD_TO_CNY_RATE, 2),
                    "is_free_tier": m_data["is_free_tier"],
                })

            # Format providers breakdown
            providers_list = []
            for p_name, p_data in sorted(provider_aggregates.items(), key=lambda x: x[1]["total_tokens"], reverse=True):
                providers_list.append({
                    "provider": p_name,
                    "display_name": p_data["display_name"],
                    "sessions": p_data["sessions"],
                    "total_tokens": p_data["total_tokens"],
                    "cost_usd": round(p_data["cost_usd"], 4),
                    "cost_cny": round(p_data["cost_usd"] * USD_TO_CNY_RATE, 2),
                    "models": sorted(list(p_data["models"])),
                    "is_free_tier": p_data["is_free_tier"],
                })

            # Detect New API / LatticeCode setup details
            new_api_info = {
                "configured": False,
                "provider": "latticecode",
                "label": "ForX New API",
                "portal_url": "",
                "inference_url": "",
                "username": "",
                "logged_in": False,
            }
            try:
                from hermes_cli import auth_lattice
                state = auth_lattice.current_lattice_state()
                p_url = auth_lattice._portal_url()
                i_url = auth_lattice._inference_url()
                new_api_info["configured"] = bool(p_url or i_url)
                new_api_info["portal_url"] = p_url
                new_api_info["inference_url"] = i_url
                if state:
                    new_api_info["username"] = state.get("username") or ""
                    new_api_info["logged_in"] = state.get("logged_in") or bool(state.get("api_key"))
            except Exception:
                pass

            return {
                "ok": True,
                "summary": {
                    "total_sessions": total_sessions,
                    "total_tokens": total_all_tokens,
                    "input_tokens": total_input,
                    "output_tokens": total_output,
                    "cache_read_tokens": total_cache_read,
                    "cache_hit_rate": avg_cache_hit_rate,
                    "total_cost_usd": round(total_cost_usd, 4),
                    "total_cost_cny": round(total_cost_usd * USD_TO_CNY_RATE, 2),
                    "status_counts": status_counts,
                },
                "new_api": new_api_info,
                "models": models_list,
                "providers": providers_list,
                "trend": list(daily_buckets.values()),
                "heatmap": list(heatmap_buckets.values()),
                "sessions": session_cards,
            }
        finally:
            db.close()
