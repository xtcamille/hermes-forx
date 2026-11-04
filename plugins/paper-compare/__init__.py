"""Paper Compare uses the plugin's own page; no tools are added to agent prompts."""


def register(ctx):
    # Discovery must stay inert: the service starts only when its page is opened.
    ctx.register_cli_command(
        name="paper", help="Paper Compare workbench diagnostics",
        setup_fn=_setup_cli, handler_fn=lambda args: _paper_cli(args, ctx.get_config('node_path')),
    )


def _setup_cli(parser):
    parser.add_argument("action", choices=["doctor"], nargs="?", default="doctor")


def _paper_cli(args, node_path=None):
    import json
    import shutil
    import subprocess
    from pathlib import Path
    from hermes_constants import get_hermes_home
    from .runtime_setup import node_command, dependencies_ready

    home = get_hermes_home()
    try:
        _, version = node_command(home, node_path)
        node_error = None
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        version, node_error = None, str(exc)
    print(json.dumps({
        "plugin": "paper-compare", "node": version,
        "node_error": node_error,
        "dependencies_installed": dependencies_ready(Path(__file__).parent / 'runtime'),
        "package_directory": str(Path(__file__).resolve().parent),
        "profile_library": str(home / 'plugin-data/paper-compare/library'),
        "poppler": {tool: bool(shutil.which(tool)) for tool in ("pdftotext", "pdftoppm", "pdfinfo")},
        "open": "Desktop sidebar → 论文工作台",
    }, ensure_ascii=False, indent=2))
