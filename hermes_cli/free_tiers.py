"""Unified Managed Free Tier registry and abstraction.

Coordinates official managed free tiers (LatticeCode Free, Nous Free Tier),
providing a common protocol for boot bootstrap, provider resolution,
runtime token acquisition, and model whitelist enforcement.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set

logger = logging.getLogger("hermes_cli.free_tiers")


@dataclass(frozen=True)
class ManagedFreeTier:
    provider_id: str
    display_name: str
    allowed_models: frozenset[str]
    default_model: str
    default_base_url: str
    is_enabled: Callable[[], bool]
    has_identity: Callable[[], bool]
    ensure_identity: Callable[..., Optional[Dict[str, Any]]]
    resolve_runtime_credentials: Callable[..., Dict[str, Any]]
    is_free_endpoint: Callable[[Any], bool]
    is_anonymous_request: Callable[[Any, Any], bool]
    pin_model: Callable[[Any, Any], Any]


_REGISTRY: Dict[str, ManagedFreeTier] = {}


def register_free_tier(tier: ManagedFreeTier) -> None:
    _REGISTRY[tier.provider_id] = tier


def get_free_tier(provider_id: str) -> Optional[ManagedFreeTier]:
    _ensure_builtin_tiers()
    return _REGISTRY.get(provider_id)


def _ensure_builtin_tiers() -> None:
    if "latticecode" not in _REGISTRY:
        from hermes_cli import auth_lattice
        lattice_tier = ManagedFreeTier(
            provider_id=auth_lattice.LATTICE_PROVIDER,
            display_name=auth_lattice.LATTICE_LABEL,
            allowed_models=auth_lattice.LATTICE_ALLOWED_MODELS,
            default_model=auth_lattice.LATTICE_DEFAULT_MODEL,
            default_base_url=auth_lattice.DEFAULT_LATTICE_INFERENCE_URL,
            is_enabled=auth_lattice.lattice_guest_enabled,
            has_identity=auth_lattice.has_lattice_guest,
            ensure_identity=auth_lattice.ensure_lattice_identity,
            resolve_runtime_credentials=auth_lattice.resolve_lattice_runtime_credentials,
            is_free_endpoint=auth_lattice.is_lattice_welcome_host,
            is_anonymous_request=auth_lattice.is_lattice_anonymous_request,
            pin_model=auth_lattice.pin_lattice_model,
        )
        register_free_tier(lattice_tier)

    if "nous" not in _REGISTRY:
        from hermes_cli import anon_auth, auth_nous
        def _resolve_nous_runtime(force_refresh: bool = False) -> Dict[str, Any]:
            creds = auth_nous.resolve_nous_runtime_credentials(force_refresh=force_refresh)
            return creds or {"api_key": "", "base_url": ""}

        nous_tier = ManagedFreeTier(
            provider_id="nous",
            display_name=anon_auth.FREE_TIER_LABEL,
            allowed_models=frozenset({anon_auth.GUEST_MODEL}),
            default_model=anon_auth.GUEST_MODEL,
            default_base_url=anon_auth.DEFAULT_NOUS_WELCOME_URL,
            is_enabled=anon_auth.guest_enabled,
            has_identity=anon_auth.has_guest,
            ensure_identity=anon_auth.ensure_portal_identity,
            resolve_runtime_credentials=_resolve_nous_runtime,
            is_free_endpoint=anon_auth.route_is_welcome_host,
            is_anonymous_request=anon_auth.is_anonymous_request,
            pin_model=lambda base_url, model: anon_auth.pin_model_for_route("nous", base_url, model),
        )
        register_free_tier(nous_tier)


def get_active_free_tier() -> Optional[ManagedFreeTier]:
    """Return the currently configured/active ManagedFreeTier.

    Priority:
    1. config.yaml ``free_tier.provider`` (explicit user setting).
    2. latticecode (default if enabled).
    3. nous (fallback if guest_enabled).
    """
    _ensure_builtin_tiers()
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly() or {}
        ft_cfg = cfg.get("free_tier")
        if isinstance(ft_cfg, dict):
            if not ft_cfg.get("enabled", True):
                return None
            p = ft_cfg.get("provider")
            if p and p in _REGISTRY:
                tier = _REGISTRY[p]
                if tier.is_enabled():
                    return tier
                return None
    except Exception as exc:
        logger.debug("Failed to read free_tier config: %s", exc)

    import os
    # Legacy Nous onboarding flag takes precedence if set in environment (used in Nous test suites)
    if os.environ.get("HERMES_GUEST_ONBOARDING") == "1":
        nous = _REGISTRY.get("nous")
        if nous and nous.is_enabled():
            return nous

    lattice = _REGISTRY.get("latticecode")
    if lattice and lattice.is_enabled():
        return lattice

    nous = _REGISTRY.get("nous")
    if nous and nous.is_enabled():
        return nous

    return None


def is_anonymous_request(provider: Any, api_key: Any) -> bool:
    """Check if (provider, api_key) corresponds to an active anonymous free tier credential."""
    _ensure_builtin_tiers()
    tier = _REGISTRY.get(str(provider or ""))
    if tier:
        return tier.is_anonymous_request(provider, api_key)
    return False
