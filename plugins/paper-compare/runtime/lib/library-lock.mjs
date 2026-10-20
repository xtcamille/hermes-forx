import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, realpathSync, fstatSync, statSync } from 'node:fs';
import { join } from 'node:path';

const leases = new Map();

// Both standalone and plugin use this lease. A second process must not run
// Library's interrupted-task recovery against a database that is still live.
export function acquireLibraryLock(directory) {
  if (!directory) return () => {};
  const path = join(realpathSync(directory), '.hermes-paper.lock');
  let lease = leases.get(path);
  if (!lease) {
    let fd;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fd = openSync(path, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('论文库锁尚未就绪，请稍后重试；不要同时启动独立版和 ForX 插件。'); }
        if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error('论文库锁信息无效，请检查数据目录。');
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
        if (alive) throw new Error('论文库已在另一个服务中使用。请打开正在运行的 ForX 论文工作台，或关闭该服务后再启动独立版。');
        unlinkSync(path);
      }
    }
    if (fd === undefined) throw new Error('无法锁定论文库，请稍后重试。');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
    catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    lease = { fd, count: 0 }; leases.set(path, lease);
  }
  lease.count++;
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--lease.count) return;
    leases.delete(path);
    try {
      const held = fstatSync(lease.fd), current = statSync(path);
      if (held.dev === current.dev && held.ino === current.ino) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { closeSync(lease.fd); }
  };
}
