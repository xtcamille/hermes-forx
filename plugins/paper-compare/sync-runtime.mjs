// Explicit allowlist: credentials, libraries, node_modules and user artifacts never enter this package.
import { cp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
if (!process.argv[2]) throw new Error('Optional developer import only: provide an explicit source directory. The installed plugin uses its own runtime.');
const source = resolve(process.argv[2]);
const destination = join(root, 'runtime');
await mkdir(destination, { recursive: true });
for (const file of ['server.mjs', 'package.json', 'package-lock.json', '.env.example', 'lib', 'public', 'test']) {
  await cp(join(source, file), join(destination, file), { recursive: true });
}
await mkdir(join(destination, 'data'), { recursive: true });
await mkdir(join(destination, 'scripts'), { recursive: true });
await cp(join(source, 'scripts/check-mineru.mjs'), join(destination, 'scripts/check-mineru.mjs'));
console.log('Paper Compare runtime synced (code and test fixtures only).');
