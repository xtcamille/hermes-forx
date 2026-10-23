"""Opt-in document capability delivered entirely through existing plugin seams."""


def register(ctx):
    from pathlib import Path
    from .cli import setup, run
    ctx.register_cli_command(name="ppt", help="Create and edit native PPTX projects",
                             setup_fn=setup, handler_fn=lambda args: run(args, ctx.llm))
    ctx.register_skill("ppt", Path(__file__).parent / "skills/ppt/SKILL.md",
                       "Create and edit native PPTX projects with stable object IDs.")
