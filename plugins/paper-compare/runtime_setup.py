"""Prepare locked Node dependencies for normal ForX catalog/ZIP installs."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent


def node_command(home, explicit=None):
    home = Path(home)
    own = home / 'plugin-data/paper-compare/runtime/node/bin' / ('node.exe' if os.name == 'nt' else 'node')
    selected = explicit or (str(own) if own.is_file() else shutil.which('node'))
    if not selected:
        raise ValueError('论文工作台需要 Node.js 22.13+；请安装 Node.js 或在插件设置中配置 node_path。')
    path = Path(selected).expanduser()
    if not path.is_absolute():
        path = home / path if len(path.parts) > 1 else Path(shutil.which(str(path)) or str(path))
    result = subprocess.run([str(path), '--version'], capture_output=True, text=True, timeout=10, check=True)
    version = result.stdout.strip()
    if tuple(int(part) for part in version.lstrip('v').split('.')[:2]) < (22, 13):
        raise ValueError('论文工作台需要 Node.js 22.13 或更新版本。')
    return str(path.resolve()), version


def dependencies_ready(directory):
    directory = Path(directory)
    expected = json.loads((directory / 'package.json').read_text())['dependencies']
    for name, version in expected.items():
        manifest = directory / 'node_modules' / name / 'package.json'
        try:
            if json.loads(manifest.read_text()).get('version') != version:
                return False
        except (OSError, ValueError):
            return False
    return True


def install_dependencies(node, directory):
    directory = Path(directory)
    cli = Path(node).parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    if not cli.is_file():
        command = shutil.which('npm')
        if not command:
            raise ValueError('首次准备论文插件需要 npm；也可使用包含生产依赖的离线 ZIP 插件包。')
        cli = Path(command).resolve()
    try:
        subprocess.run([str(node), str(cli), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                       cwd=directory, check=True, capture_output=True, timeout=180)
    except (subprocess.SubprocessError, OSError):
        raise ValueError('论文插件依赖准备失败。请检查 npm 网络连接，或改用包含生产依赖的 ZIP 插件包；论文库未改动。') from None
    if not dependencies_ready(directory):
        raise ValueError('论文插件生产依赖校验失败，请重新安装插件包。')


def prepare(home, explicit=None):
    node, _ = node_command(home, explicit)
    directory = ROOT / 'runtime'
    if not dependencies_ready(directory):
        install_dependencies(node, directory)
    return node
