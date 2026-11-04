"""Build the unified ForX ZIP package without local data or credentials."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent


def build(output, *, source_only=False):
    spec = importlib.util.spec_from_file_location('paper_release_install', ROOT / 'install.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    spec = importlib.util.spec_from_file_location('paper_release_runtime', ROOT / 'runtime_setup.py')
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='forx-paper-release-') as directory:
        stage = Path(directory).resolve() / 'paper-compare'
        installer._copy_package(stage, reuse_dependencies=False)
        if not source_only:
            node, _ = runtime.node_command(Path(directory))
            runtime.install_dependencies(node, stage / 'runtime')
        import yaml
        version = yaml.safe_load((stage / 'plugin.yaml').read_text())['version']
        suffix = '-source' if source_only else ''
        archive = output / f'paper-compare-{version}{suffix}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(stage.rglob('*')):
                if not path.is_file():
                    continue
                if path.is_symlink() and not path.resolve().is_relative_to(stage):
                    raise ValueError('Plugin package contains an external symlink.')
                if '__pycache__' in path.parts or path.suffix in ('.pyc', '.pyo'):
                    continue
                bundle.write(path, 'paper-compare/' + path.relative_to(stage).as_posix())
    result = {'package': str(archive), 'pluginVersion': version, 'productionDependencies': not source_only,
              'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    archive.with_suffix('.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parents[1] / 'artifacts/paper-compare')
    parser.add_argument('--source-only', action='store_true', help='Omit dependencies; ForX prepares them at first launch.')
    args = parser.parse_args()
    print(json.dumps(build(args.output, source_only=args.source_only), ensure_ascii=False, indent=2))
