import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentFingerprint } from './documents.mjs';

export const DEFAULT_VISUAL_CACHE = fileURLToPath(new URL('../.paper-cache/visual/', import.meta.url));
export const VISUAL_CACHE_VERSION = 2;
const AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 256 * 1024 * 1024;
const extractionScopes = new WeakMap();

export class VisualCache {
  constructor(directory = DEFAULT_VISUAL_CACHE) { this.directory = directory; this.memory = new Map(); this.namespace = directory || randomUUID(); this.lastPrune = 0; }
  scope(config, model, doc) {
    const parts = [VISUAL_CACHE_VERSION, config.baseUrl, config.credentialScope || config.apiKey, model, 'jpeg-2600-quality90'];
    if ((doc?.extractionVersion || 1) > 1) {
      if (!extractionScopes.has(doc)) extractionScopes.set(doc, createHash('sha256').update(JSON.stringify(doc.pages || [])).digest('hex'));
      parts.push(doc.extractionVersion, extractionScopes.get(doc));
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
  key(config, model, doc, page) { return `${documentFingerprint(doc)}-${this.scope(config, model, doc)}-${page}`; }
  async get(config, model, doc, page) {
    const key = this.key(config, model, doc, page);
    let value = this.memory.get(key);
    if (!value && this.directory) { try { value = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8')); } catch {} }
    if (!value || value.version !== VISUAL_CACHE_VERSION || value.documentHash !== documentFingerprint(doc) || value.page !== page || value.model !== model || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200_000 || !Number.isFinite(Date.parse(value.createdAt)) || Date.now() - Date.parse(value.createdAt) > AGE) return null;
    this.memory.set(key, value); return value;
  }
  async put(config, model, doc, page, answer) {
    const key = this.key(config, model, doc, page);
    const value = { version: VISUAL_CACHE_VERSION, documentHash: documentFingerprint(doc), model, page, text: answer.text, usageTokens: answer.usage?.total_tokens || answer.usageTokens || 0, createdAt: new Date().toISOString() };
    if (!value.text?.trim() || answer.finishReason === 'length') throw new Error('不保存未完成的视觉转录。');
    if (this.directory) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, join(this.directory, `${key}.json`)); }
      finally { await rm(temporary, { force: true }); }
      await this.prune();
    }
    this.memory.set(key, value);
    if (this.memory.size > 160) this.memory.delete(this.memory.keys().next().value);
    return value;
  }
  async prune() {
    if (!this.directory || Date.now() - this.lastPrune < 60_000) return;
    this.lastPrune = Date.now();
    const files = await Promise.all((await readdir(this.directory)).filter(name => /^[a-f0-9]{64}-[a-f0-9]{64}-\d+\.json$/.test(name)).map(async name => { try { const info = await stat(join(this.directory, name)); return { name, size: info.size, at: info.mtimeMs }; } catch { return null; } }));
    const sorted = files.filter(Boolean).sort((a, b) => b.at - a.at); let total = 0;
    for (const file of sorted) { total += file.size; if (Date.now() - file.at > AGE || total > MAX_BYTES) await rm(join(this.directory, file.name), { force: true }); }
  }
  async deleteDocument(doc) {
    const prefix = documentFingerprint(doc) + '-';
    for (const key of this.memory.keys()) if (key.startsWith(prefix)) this.memory.delete(key);
    if (this.directory) {
      const names = await readdir(this.directory).catch(() => []);
      await Promise.all(names.filter(name => name.startsWith(prefix) && /^[a-f0-9-]+\.json$/.test(name)).map(name => rm(join(this.directory, name), { force: true })));
    }
  }
}

export function splitSavedTranscript(text, pages) {
  const sections = [...String(text).matchAll(/^#{1,6}[^\n]*\[P(\d+)\][^\n]*\n/gm)];
  if (pages.length === 1) return new Map([[pages[0], text]]);
  const result = new Map();
  for (let index = 0; index < sections.length; index++) {
    const page = Number(sections[index][1]); if (!pages.includes(page) || result.has(page)) continue;
    result.set(page, text.slice(sections[index].index, sections[index + 1]?.index ?? text.length));
  }
  return result;
}
