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
    import os
    from pathlib import Path
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    own = home / 'plugin-data/paper-compare/runtime/node/bin' / ('node.exe' if os.name == 'nt' else 'node')
    node = node_path or (str(own) if own.is_file() else shutil.which("node"))
    if node and len(Path(node).parts) > 1 and not Path(node).is_absolute():
        node = str(home / node)
    version = subprocess.check_output([node, "--version"], text=True).strip() if node else None
    print(json.dumps({
        "plugin": "paper-compare", "node": version,
        "dependencies_installed": (Path(__file__).parent / "runtime/node_modules/katex").is_dir(),
        "package_directory": str(Path(__file__).resolve().parent),
        "profile_library": str(home / 'plugin-data/paper-compare/library'),
        "poppler": {tool: bool(shutil.which(tool)) for tool in ("pdftotext", "pdftoppm", "pdfinfo")},
        "open": "Desktop sidebar → 论文工作台",
    }, ensure_ascii=False, indent=2))
