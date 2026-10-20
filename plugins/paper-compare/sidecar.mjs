import { createHash, randomBytes } from 'node:crypto';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApplication } from './runtime/server.mjs';

export function frameSource(origin) {
  if (['null', 'file://', 'file:'].includes(origin)) return 'file:';
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid frame origin');
  return url.origin;
}

export async function startWorkbench(config) {
  const ancestor = frameSource(config.frameOrigin || 'null');
  const directory = resolve(config.dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const basePath = `/workbench/${randomBytes(24).toString('hex')}/`;
  const storageScope = /^[a-f0-9]{64}$/.test(config.browserStorageScope || '') ? config.browserStorageScope
    : createHash('sha256').update(JSON.stringify([config.storageScope, directory])).digest('hex');
  let app;
  try {
    const report = join(directory, 'vision-capabilities.json');
    process.env.PAPER_VISION_REPORT = report;
    if (config.visionReport) {
      try { await copyFile(config.visionReport, report, (await import('node:fs')).constants.COPYFILE_EXCL); await chmod(report, 0o600); }
      catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
    }
    app = createApplication({ ...config, dataDirectory: directory, cacheDirectory: join(directory, 'cache', 'visual') });
    const [handle] = app.server.listeners('request');
    app.server.removeAllListeners('request');
    app.server.on('request', (request, response) => {
      const path = request.url.split('?')[0];
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (!path.startsWith(basePath)) { response.writeHead(404); response.end(); return; }
      request.url = '/' + request.url.slice(basePath.length);
      if (request.url.split('?')[0] === '/') {
        const end = response.end.bind(response);
        response.end = (body, ...args) => end(Buffer.from(body).toString('utf8').replace('<head>', `<head><meta name="paper-storage-scope" content="${storageScope}">`), ...args);
      }
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'content-security-policy'
        ? value.replace("frame-ancestors 'none'", `frame-ancestors ${ancestor} file: http://127.0.0.1:* http://localhost:*`)
        : name.toLowerCase() === 'referrer-policy' ? 'no-referrer' : value);
      if (request.url.split('?')[0] === '/integration/status') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ plugin: 'paper-compare', activeJobs: app.workspace.count, instance: config.instance })); return;
      }
      handle(request, response);
    });
    app.server.listen(config.port || 0, '127.0.0.1'); await once(app.server, 'listening');
    let closing;
    const close = () => closing ||= (async () => {
      const interrupted = [...app.workspace.active.values()];
      const interruptedReadings = [...app.workspace.readings.active.values()];
      for (const context of app.workspace.readings.active.values()) context.controller.abort();
      for (const context of app.workspace.active.values()) { clearTimeout(context.timer); app.workspace.flush(context); context.controller.abort(); }
      app.server.close(); app.server.closeAllConnections();
      // Aborting a stream schedules final persistence. Let it settle while
      // SQLite is still open; a backend shutdown is recoverable interruption.
      const deadline = Date.now() + 4000;
      while ((app.workspace.count || app.workspace.readings.jobs.size) && Date.now() < deadline) await delay(20);
      for (const context of interrupted) {
        context.task.status = 'interrupted'; context.turn.status = 'interrupted';
        for (const output of [...context.turn.answers, context.turn.analysis, ...(context.turn.verifications || [])]) {
          if (['cancelled', 'running', 'waiting', 'continuing'].includes(output.status)) {
            output.status = 'interrupted';
            for (const segment of output.segments || []) if (['running', 'cancelled'].includes(segment.status)) segment.status = 'interrupted';
            app.library.put('generation', output);
          }
        }
        app.library.put('task', context.task); app.library.put('turn', context.turn, true);
      }
      for (const context of interruptedReadings) {
        context.task.status = 'interrupted'; app.library.put('reading-task', context.task);
        const reading = context.task.readingId && app.library.get('reading', context.task.readingId);
        if (reading && reading.status !== 'done') { reading.status = 'interrupted'; app.library.put('reading', reading); }
      }
      // On a hard timeout the process exits immediately after this method;
      // leaving SQLite to process teardown avoids callbacks writing a closed DB.
      if (!app.workspace.count && !app.workspace.readings.jobs.size) app.library.close();
    })();
    return { app, url: `http://127.0.0.1:${app.server.address().port}${basePath}`, close };
  } catch (error) { app?.server.close(); app?.library.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = createInterface({ input: process.stdin, terminal: false });
  const line = await new Promise(resolve => input.once('line', resolve));
  let sequence = 0;
  const pending = new Map();
  input.on('line', line => {
    try {
      const message = JSON.parse(line), request = pending.get(message.id);
      if (!request || !message.credentials) return;
      pending.delete(message.id); clearTimeout(request.timer); request.resolve(message.credentials);
    } catch { /* Invalid control frames never enter the application. */ }
  });
  const resolveConfig = () => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ForX 凭据连接超时，请重新连接论文工作台。')); }, 40_000);
    pending.set(id, { resolve, reject, timer });
    process.stdout.write(JSON.stringify({ type: 'credentials', id }) + '\n');
  });
  input.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ForX 后端连接已断开。')); }
    pending.clear();
  });
  let workbench;
  try {
    const config = JSON.parse(line);
    workbench = await startWorkbench({ ...config, resolveConfig });
    process.stdout.write(JSON.stringify({ ready: true, url: workbench.url, pid: process.pid }) + '\n');
    const parent = config.parentPid;
    const monitor = setInterval(() => { try { process.kill(parent, 0); } catch (error) { if (error.code === 'ESRCH') void exit(); } }, 3000);
    const exit = async () => { clearInterval(monitor); await workbench.close(); process.exit(0); };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void exit());
  } catch (error) {
    // Startup diagnostics must not serialize config, endpoint credentials or argv.
    process.stderr.write('Paper Compare: ' + String(error.code || 'START_FAILED') + '\n');
    process.exit(1);
  }
}
