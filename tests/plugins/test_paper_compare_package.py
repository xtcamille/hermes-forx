"""Exercise standard Git delivery and offline locked runtime preparation."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile

PLUGIN = Path(__file__).resolve().parents[2] / 'plugins/paper-compare'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_release_installs_through_forx_git_with_an_exact_revision_and_no_private_data(tmp_path, monkeypatch):
    installer = load('paper_package_fixture', PLUGIN / 'install.py')
    source = tmp_path / 'source'
    installer._copy_package(source, reuse_dependencies=False)
    (source / '.env').write_text('PRIVATE_TEST_VALUE=do-not-export')
    (source / 'runtime/.paper-data').mkdir()
    (source / 'runtime/.paper-data/library.sqlite').write_text('private test data')
    builder = load('paper_release_fixture', PLUGIN / 'build_release.py')
    builder.ROOT = source
    result = builder.build(tmp_path / 'output', source_only=True)
    repo = tmp_path / 'repository'; (repo / 'plugins').mkdir(parents=True)
    with zipfile.ZipFile(result['package']) as archive:
        assert not any(name.endswith('.env') or 'library.sqlite' in name or 'node_modules/' in name for name in archive.namelist())
        archive.extractall(repo / 'plugins')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', *args], text=True).strip()
    git('init', '-q'); git('config', 'user.name', 'Plugin Test'); git('config', 'user.email', 'plugin-test@example.invalid')
    git('add', '.'); git('commit', '-qm', 'test plugin source'); sha = git('rev-parse', 'HEAD')
    home = tmp_path / 'profile'; home.mkdir()
    monkeypatch.setenv('FORX_HOME', str(home)); monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    from hermes_cli.plugins_cmd import _install_plugin_core, _read_install_metadata, _set_plugin_enabled
    from hermes_cli.plugins import PluginManager
    from hermes_cli.plugin_validate import validate_plugin_dir
    target, manifest, name = _install_plugin_core(repo.as_uri() + '#plugins/paper-compare', force=False, ref=sha, reviewed_pin=sha)
    _set_plugin_enabled(name, enable=True)
    assert target == home / 'plugins/paper-compare'
    assert manifest['version'] == result['pluginVersion']
    assert _read_install_metadata()[name]['revision'] == sha
    assert _read_install_metadata()[name]['pinned'] is True
    assert validate_plugin_dir(target).ok
    manager = PluginManager(scope_key=str(home)); manager.discover_and_load()
    installed = next(row for row in manager.list_plugins() if row['name'] == name)
    assert installed['enabled'] and not installed['error']
    assert not (home / 'plugin-data/paper-compare/library').exists()


def test_first_launch_prepares_locked_dependencies_offline_and_then_reuses_them(tmp_path, monkeypatch):
    setup = load('paper_runtime_fixture', PLUGIN / 'runtime_setup.py')
    setup.ROOT = tmp_path
    runtime = tmp_path / 'runtime'; runtime.mkdir()
    tarball = tmp_path / 'fixture.tgz'
    files = {'package/package.json': json.dumps({'name':'paper-runtime-fixture','version':'1.0.0','type':'module','exports':'./index.js'}),
             'package/index.js': 'export const value = "prepared locally";'}
    with tarfile.open(tarball, 'w:gz') as archive:
        for name, text in files.items():
            data=text.encode(); entry=tarfile.TarInfo(name);entry.size=len(data);entry.mode=0o644
            archive.addfile(entry,io.BytesIO(data))
    dependencies = {'paper-runtime-fixture':'1.0.0'}
    (runtime / 'package.json').write_text(json.dumps({'name':'reader-fixture','version':'1.0.0','private':True,'dependencies':dependencies}))
    integrity='sha512-'+base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()
    (runtime / 'package-lock.json').write_text(json.dumps({'name':'reader-fixture','version':'1.0.0','lockfileVersion':3,'requires':True,'packages':{
        '':{'name':'reader-fixture','version':'1.0.0','dependencies':dependencies},
        'node_modules/paper-runtime-fixture':{'version':'1.0.0','resolved':tarball.as_uri(),'integrity':integrity}}}))
    monkeypatch.setenv('npm_config_offline','true');monkeypatch.setenv('npm_config_cache',str(tmp_path/'npm-cache'))
    assert not setup.dependencies_ready(runtime)
    node=setup.prepare(tmp_path/'home',shutil.which('node'))
    assert setup.dependencies_ready(runtime)
    assert subprocess.check_output([node,'--input-type=module','-e',"import {value} from 'paper-runtime-fixture'; console.log(value)"],cwd=runtime,text=True).strip()=='prepared locally'
    marker=runtime/'node_modules/paper-runtime-fixture/keep-marker';marker.write_text('already prepared')
    setup.prepare(tmp_path/'home',node)
    assert marker.read_text()=='already prepared'
