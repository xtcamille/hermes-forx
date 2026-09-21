"""LatticeCode Free model provider profile."""

from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

class LatticeCodeProfile(ProviderProfile):
    """LatticeCode profile with New API credentials and anonymous free tier."""

    def auth_handler(self, action: str, args: Any) -> bool:
        from hermes_cli.auth_lattice import lattice_auth_handler
        return lattice_auth_handler(action, args)


latticecode = LatticeCodeProfile(
    name="latticecode",
    aliases=("lattice", "lattice-code", "latticecode-free"),
    display_name="LatticeCode Free",
    description="LatticeCode Free Tier (No API key required)",
    signup_url="https://latticecode.com/",
    fallback_models=(
        "latticecode/free-coder",
        "latticecode/free-chat",
        "latticecode/free-r1",
    ),
    default_aux_model="latticecode/free-coder",
    base_url="http://192.168.1.206:3000/v1",
    api_mode="chat_completions",
    supports_vision=False,
    auth_type="oauth_device_code",
)

register_provider(latticecode)
