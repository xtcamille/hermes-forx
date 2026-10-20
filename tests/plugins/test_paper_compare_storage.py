"""Preserve every library record while retiring a development install and its old paths."""
from __future__ import annotations

import importlib.util
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN = Path(__file__).resolve().parents[2] / "plugins/paper-compare"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def seed(source):
    script = r"""
      import {readFileSync,mkdirSync} from 'node:fs'; import{join}from'node:path'; import{pathToFileURL}from'node:url';
      const root=process.argv[1],directory=process.argv[2];
      const {Library}=await import(pathToFileURL(join(root,'runtime/lib/library.mjs')));
      const library=new Library(directory), id='22222222-2222-4222-8222-222222222222';
      const file=readFileSync(join(root,'runtime/test/assets/visual-fixture.pdf'));
      const doc=library.addDocument({id,name:'original-paper.pdf',format:'pdf',sourceType:'page',pages:['Original evidence paragraph. Formula x^2.'],chars:44,createdAt:'2026-01-01T00:00:00Z'},file);
      const turnId='33333333-3333-4333-8333-333333333333';
      const generation={id:'generation',turnId,documentId:id,model:'k3',kind:'answer',status:'done',version:1,text:'Equation \\(x^2\\) [P1.1]',segments:[{text:'Equation \\(x^2\\) [P1.1]',finishReason:'stop'}]};
      const claim={id:'claim',documentId:id,turnId,text:'Formula x^2',refs:['P1.1']};
      const verification={id:'verification',documentId:id,turnId,model:'k3',kind:'verification',status:'done',text:'支持 [P1.1]',verdict:'supported',refs:['P1.1']};
      for(const [kind,value] of [
        ['conversation',{id:'conversation',documentId:id,title:'Original conversation',extractionVersion:1,createdAt:'2026-01-01T00:00:00Z'}],
        ['turn',{id:turnId,documentId:id,document:{id,name:doc.name,format:'pdf',sourceType:'page',pages:1,extractionVersion:1},conversationId:'conversation',question:'Original question',models:['k3'],status:'done',startedAt:'2026-01-01T00:00:00Z',answers:[generation],analysis:{id:'analysis',status:'off',text:''},claims:[claim],verifications:[verification],history:[],options:{}}],
        ['generation',generation],['claim',claim],['verification',verification],
        ['evidence',{id:'evidence',documentId:id,ref:'P1.1',text:'Original evidence paragraph.',extractionVersion:1}],
        ['note',{id:'note',documentId:id,text:'Original personal note'}],
        ['transcript',{id:'transcript',documentId:id,text:'Saved formula transcription',reader:'reader'}],
        ['layout',{id:'layout',documentId:id,page:1,boxes:[{x:1,y:2,width:3,height:4}]}],
        ['extraction',{id:id+':v1',documentId:id,version:1,document:{...doc,pdfBuffer:undefined}}]
      ])library.put(kind,value);
      library.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('historic-task',1,'done','{}');
      library.close();console.log(id);
    """
    return subprocess.check_output([shutil.which("node"), "--input-type=module", "-e", script, str(PLUGIN), str(source)], text=True).strip()


def test_migration_and_copied_install_run_without_the_original_paths(tmp_path, monkeypatch):
    old_tool = tmp_path / "old-tool"
    source = old_tool / ".paper-data"
    document = seed(source)
    storage = load(PLUGIN / "storage.py", "paper_storage_migration_test")
    baseline = storage.audit(source)
    package_source = tmp_path / "development-plugin"
    shutil.copytree(PLUGIN, package_source, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    installer = load(package_source / "install.py", "paper_storage_installer_test")
    home = tmp_path / "forx"
    home.mkdir()
    (home / "plugins").mkdir()
    (home / "plugins/paper-compare").symlink_to(package_source)
    parser_file = old_tool / "private.env"
    parser_file.write_text('LLM_API_KEY=must-not-migrate-this-key\nMINERU_BASE_URL=http://127.0.0.1:8000/v1\nMINERU_API_KEY=private-parser-key\n')
    vision = old_tool / "vision.json"
    vision.write_text('{"baseUrl":"http://127.0.0.1:3000/v1","models":[]}')
    config = {"model": {"provider": "latticecode", "default": "k3"}, "plugins": {"enabled": ["paper-compare"], "entries": {"paper-compare": {"settings": {"data_dir": str(source), "env_file": str(parser_file), "vision_report": str(vision), "node_path": shutil.which("node"), "pdf_parser": "poppler"}}}}}
    (home / "config.yaml").write_text(yaml.safe_dump(config))
    from hermes_cli.auth import _save_auth_store
    _save_auth_store({"active_provider": "latticecode", "providers": {"latticecode": {"auth_method": "password", "logged_in": True, "username": "researcher", "api_key": "forx-native-test-key", "inference_base_url": "http://127.0.0.1:3000/v1", "token_refreshed_at": time.time()}}}, target_path=home / "auth.json")
    monkeypatch.setenv("FORX_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    from agent import secret_scope
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    migrated = storage.migrate(home)
    target = home / storage.LIBRARY_PATH
    backup = Path(migrated["backup"])
    assert storage.audit(source) == baseline
    assert storage.audit(target)["tables"] == baseline["tables"]
    assert storage.audit(backup / "library")["tables"] == baseline["tables"]
    assert (backup / "config.yaml").read_text() == yaml.safe_dump(config)
    assert (target / "vision-capabilities.json").read_bytes() == vision.read_bytes()
    assert not storage.migrate(home)["migrated"]
    installed = installer.install(home, skip_deps=True)
    own_package = home / "plugins/paper-compare"
    assert installed["mode"] == "self-contained-copy" and not own_package.is_symlink()
    assert installed["data"] == "profile-local library"
    final_config = (home / "config.yaml").read_text()
    assert str(old_tool) not in final_config and str(package_source) not in final_config
    parser_copy = home / "plugin-data/paper-compare/parser.env"
    assert 'must-not-migrate-this-key' not in parser_copy.read_text()
    assert 'private-parser-key' in parser_copy.read_text()
    old_tool.rename(tmp_path / "retired-old-tool")
    package_source.rename(tmp_path / "retired-development-plugin")
    assert not old_tool.exists() and not package_source.exists()
    module = load(own_package / "dashboard/plugin_api.py", "paper_copied_api_test")
    app = FastAPI()
    app.include_router(module.router, prefix="/api/plugins/paper-compare")
    try:
        with TestClient(app) as client, httpx.Client(timeout=20) as browser:
            response = client.post('/api/plugins/paper-compare/launch', json={'frameOrigin': 'null'})
            assert response.status_code == 200, response.text
            url = response.json()['url']
            assert browser.get(url + 'api/library').json()['stats']['turns'] == 1
            response = browser.get(url + 'api/turns/33333333-3333-4333-8333-333333333333')
            assert response.status_code == 200, response.text
            restored = response.json()
            assert restored['answers'][0]['text'] == r'Equation \(x^2\) [P1.1]'
            assert restored['verifications'][0]['verdict'] == 'supported'
            assert browser.get(url + f'api/documents/{document}/file').content == (PLUGIN / 'runtime/test/assets/visual-fixture.pdf').read_bytes()
            assert browser.get(url + 'vendor/katex/katex.min.js').status_code == 200
            cfg = browser.get(url + 'api/config').json()
            assert cfg['managedConnection'] and cfg['keyConfigured']
            assert browser.get(url).text.split('name="paper-storage-scope" content="')[1].split('"')[0] == yaml.safe_load(final_config)['plugins']['entries']['paper-compare']['settings']['browser_storage_scope']
    finally:
        module.service.shutdown()
    # An update launched from the installed package itself also works after
    # both the former app and the development checkout have disappeared.
    copied_installer = load(own_package / 'install.py', 'paper_profile_self_update_test')
    updated = copied_installer.install(home, skip_deps=True)
    assert updated['mode'] == 'self-contained-copy' and not own_package.is_symlink()
    assert not old_tool.exists() and not package_source.exists()
    assert storage.audit(target)['tables'] == baseline['tables']


def test_migration_refuses_live_sources_and_existing_destinations(tmp_path):
    source = tmp_path / "old-library"
    seed(source)
    storage = load(PLUGIN / "storage.py", "paper_storage_safety_test")
    home = tmp_path / "forx"
    home.mkdir()
    config = yaml.safe_dump({'plugins': {'entries': {'paper-compare': {'settings': {'data_dir': str(source)}}}}})
    (home / 'config.yaml').write_text(config)
    before = storage.audit(source)
    with storage.library_lease(source):
        with pytest.raises(RuntimeError, match='仍在使用'):
            storage.migrate(home)
    target = home / storage.LIBRARY_PATH
    target.mkdir(parents=True)
    sentinel = target / 'existing-file'
    sentinel.write_text('Do not overwrite another library')
    with pytest.raises(ValueError, match='已经存在'):
        storage.migrate(home)
    assert sentinel.read_text() == 'Do not overwrite another library'
    assert (home / 'config.yaml').read_text() == config
    assert storage.audit(source) == before


def test_live_wal_snapshot_is_a_standalone_read_only_backup(tmp_path):
    source = tmp_path / 'live-library'
    seed(source)
    storage = load(PLUGIN / 'storage.py', 'paper_live_snapshot_test')
    with sqlite3.connect(source / 'library.sqlite') as live:
        live.execute('PRAGMA journal_mode=WAL')
        live.execute("INSERT INTO imports VALUES(?)", ('live-record',))
        live.commit()
        destination = tmp_path / 'backup'
        before = storage.snapshot(source, destination)
        assert live.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
        assert storage.audit(destination) == before
        # Reopen a copy containing only the main database in a read-only folder.
        readonly = tmp_path / 'readonly'
        readonly.mkdir()
        database = readonly / 'library.sqlite'
        shutil.copyfile(destination / 'library.sqlite', database)
        database.chmod(0o400)
        readonly.chmod(0o500)
        try:
            with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as restored:
                assert restored.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
                assert restored.execute('SELECT id FROM imports WHERE id=?', ('live-record',)).fetchone() == ('live-record',)
                assert restored.execute('SELECT COUNT(*) FROM records').fetchone()[0] == before['tables']['records']['rows']
            assert [p.name for p in readonly.iterdir()] == ['library.sqlite']
        finally:
            readonly.chmod(0o700)
    # The same operation must also work once the last writer has closed and
    # removed its shared-memory sidecar, without changing the source file.
    database = source / 'library.sqlite'
    original_bytes = database.read_bytes()
    closed_backup = tmp_path / 'closed-backup'
    storage.snapshot(source, closed_backup)
    assert database.read_bytes() == original_bytes
    assert storage.audit(closed_backup)['tables'] == storage.audit(source)['tables']
