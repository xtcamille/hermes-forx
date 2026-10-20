import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../lib/library.mjs';

test('another process cannot recover a live library; closing the owner permits safe recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-library-lease-'));
  const library = new Library(directory), module = new URL('../lib/library.mjs', import.meta.url).href;
  library.put('task', { id: 'active', status: 'running' });
  const code = `import {Library} from ${JSON.stringify(module)}; const library=new Library(process.argv[1]); console.log(library.get('task','active').status); library.close();`;
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, directory]), error => /论文库已在另一个服务中使用/.test(error.stderr));
    assert.equal(library.get('task', 'active').status, 'running');
    library.close();
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, directory]);
    assert.equal(result.stdout.trim(), 'interrupted');
  } finally { if (library.db.isOpen) library.close(); await rm(directory, { recursive: true, force: true }); }
});
