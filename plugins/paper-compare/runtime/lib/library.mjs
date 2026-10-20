import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { documentSummary, documentFingerprint } from './documents.mjs';
import { acquireLibraryLock } from './library-lock.mjs';

const now = () => new Date().toISOString();
export class Library {
  constructor(directory = null) {
    this.directory = directory; this.buffers = new Map(); this.cache = new Map();
    if (directory) { mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(join(directory, 'files'), { recursive: true, mode: 0o700 }); }
    this.releaseLock = acquireLibraryLock(directory);
    try {
      this.db = new DatabaseSync(directory ? join(directory, 'library.sqlite') : ':memory:');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, updated TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,document_id TEXT,parent_id TEXT,updated TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE INDEX IF NOT EXISTS records_doc ON records(document_id,kind,updated);
        CREATE INDEX IF NOT EXISTS records_parent ON records(parent_id,kind);
        CREATE TABLE IF NOT EXISTS events(task_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task_id,seq));
        CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY);
        PRAGMA user_version=1;`);
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind UNINDEXED,id UNINDEXED,document_id UNINDEXED,title,body,tokenize='trigram')");
      if (directory) chmodSync(join(directory, 'library.sqlite'), 0o600);
      for (const task of this.list('task')) if (['running', 'queued'].includes(task.status)) {
        task.status = 'interrupted'; task.seq = (task.seq || 0) + 1; this.put('task', task);
        const turn = this.get('turn', task.turnId);
        if (turn) {
          turn.status = 'interrupted';
          for (const item of [...turn.answers, turn.analysis, ...(turn.verifications || [])]) if (item && ['running', 'waiting', 'continuing'].includes(item.status)) {
            item.status = 'interrupted';
            for (const segment of item.segments || []) if (segment.status === 'running') segment.status = 'interrupted';
            if (item.id) this.put('generation', item);
          }
          if (turn.visual && turn.visual.status !== 'done') turn.visual.status = 'interrupted';
          this.put('turn', turn, true);
        }
      }
      for (const reading of this.list('reading')) if (['running', 'waiting', 'continuing'].includes(reading.status)) {
        reading.status = 'interrupted'; reading.phase = '';
        for (const segment of reading.segments || []) if (segment.status === 'running') segment.status = 'interrupted';
        this.put('reading', reading);
      }
      for (const task of this.list('reading-task')) if (['running', 'queued'].includes(task.status)) { task.status = 'interrupted'; task.seq = (task.seq || 0) + 1; this.put('reading-task', task); }
    } catch (error) { this.db?.close(); this.releaseLock(); throw error; }
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  index(kind, id, documentId, title, text) {
    this.db.prepare('DELETE FROM search_index WHERE kind=? AND id=?').run(kind, id);
    this.db.prepare('INSERT INTO search_index(kind,id,document_id,title,body) VALUES(?,?,?,?,?)').run(kind, id, documentId, title || '', text || '');
  }
  addDocument(doc, bytes = doc.pdfBuffer) {
    const legacyFingerprint = documentFingerprint(doc);
    const fingerprint = bytes ? createHash('sha256').update(bytes).digest('hex') : legacyFingerprint;
    let existing = this.db.prepare('SELECT id,body FROM documents WHERE fingerprint=?').get(fingerprint);
    if (!existing && bytes) existing = this.db.prepare('SELECT id,body FROM documents WHERE id=?').get(doc.id);
    if (existing) {
      const saved = JSON.parse(existing.body);
      if (saved.hasFile || !bytes) { this.touch(saved.id); return this.getDocument(saved.id); }
      doc = { ...saved, contentFingerprint: fingerprint };
    }
    const record = { ...doc, contentFingerprint: fingerprint, fingerprints: [...new Set([fingerprint, legacyFingerprint, ...(doc.fingerprints || [])])], hasFile: !!bytes, extractionVersion: doc.extractionVersion || 1, readingStatus: doc.readingStatus || 'unread', lastReadAt: now() };
    delete record.pdfBuffer; delete record.pdfBase64; delete record.originalBuffer;
    if (bytes) {
      if (this.directory) {
        const path = join(this.directory, 'files', fingerprint), temp = `${path}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, path); } finally { rmSync(temp, { force: true }); }
      } else this.buffers.set(fingerprint, bytes);
    }
    this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,updated=excluded.updated,body=excluded.body').run(record.id, fingerprint, now(), JSON.stringify(record));
    this.index('document', record.id, record.id, record.name, record.pages.join('\n'));
    this.cache.delete(record.id);
    this.relink(record);
    return this.getDocument(record.id);
  }
  findDocumentByFingerprint(fingerprint) {
    const row = this.db.prepare('SELECT id FROM documents WHERE fingerprint=?').get(fingerprint);
    return row ? this.getDocument(row.id, false) : undefined;
  }
  hasLegacyExtraction(fingerprint) {
    return !!this.db.prepare("SELECT 1 FROM records WHERE kind='turn' AND json_extract(body,'$.document.fingerprint')=? AND coalesce(json_extract(body,'$.document.extractionVersion'),1)=1 LIMIT 1").get(fingerprint);
  }
  relink(doc) {
    const orphanIds = new Set(this.list('turn').filter(t => (doc.fingerprints || [doc.contentFingerprint]).includes(t.document?.fingerprint) && t.document.id !== doc.id).map(t => t.document.id));
    for (const oldId of orphanIds) {
      const rows = this.db.prepare('SELECT kind,body FROM records WHERE document_id=?').all(oldId);
      this.transaction(() => {
        for (const row of rows) {
          const item = JSON.parse(row.body); item.documentId = doc.id;
          if (item.document) item.document = documentSummary(doc);
          if (row.kind === 'conversation') item.missingFile = false;
          for (const generation of [...(item.answers || []), ...(item.analysis ? [item.analysis] : [])]) generation.documentId = doc.id;
          for (const claim of item.claims || []) { claim.documentId = doc.id; for (const ref of claim.evidence || []) ref.documentId = doc.id; }
          this.put(row.kind, item, ['turn', 'note'].includes(row.kind));
        }
      });
    }
  }
  rawFile(doc) { if (!doc.hasFile) return null; try { return this.directory ? readFileSync(join(this.directory, 'files', doc.contentFingerprint)) : this.buffers.get(doc.contentFingerprint); } catch { return null; } }
  getDocument(id, withBytes = true, extractionVersion = null) {
    let doc = this.cache.get(id);
    if (!doc) { const row = this.db.prepare('SELECT body FROM documents WHERE id=?').get(id); if (!row) return undefined; doc = JSON.parse(row.body); }
    if (extractionVersion != null && Number(extractionVersion) !== (doc.extractionVersion || 1)) {
      if (!Number.isSafeInteger(Number(extractionVersion)) || Number(extractionVersion) < 1) return undefined;
      const saved = this.get('extraction', `${id}:v${Number(extractionVersion)}`);
      if (!saved) return undefined;
      const archived = saved.document;
      if (withBytes && archived.format === 'pdf') archived.pdfBuffer = this.rawFile(doc);
      return archived;
    }
    if (withBytes && doc.format === 'pdf' && !doc.pdfBuffer) doc.pdfBuffer = this.rawFile(doc);
    this.cache.delete(id); this.cache.set(id, doc);
    let bytes = [...this.cache.values()].reduce((sum, d) => sum + (d.pdfBuffer?.length || 0), 0);
    while (this.cache.size > 12 || bytes > 150 * 1024 * 1024) { const first = this.cache.keys().next().value; if (first === id && this.cache.size === 1) break; bytes -= this.cache.get(first).pdfBuffer?.length || 0; this.cache.delete(first); }
    return doc;
  }
  replaceExtraction(id, parsed, expectedVersion) {
    const current = this.getDocument(id, false);
    if (!current || (current.extractionVersion || 1) !== expectedVersion) throw Object.assign(new Error('论文提取版本已更新，请刷新后重试。'), { status: 409 });
    if (parsed.pages.length !== current.pages.length) throw new Error('重新解析的物理页数与原文件不一致，原提取版本已保留。');
    const plain = value => { const copy = { ...value }; delete copy.pdfBuffer; delete copy.pdfBase64; delete copy.originalBuffer; return copy; };
    const next = { ...plain(current), ...plain(parsed), id, name: current.name, createdAt: current.createdAt,
      hasFile: current.hasFile, contentFingerprint: current.contentFingerprint, fingerprints: current.fingerprints,
      readingStatus: current.readingStatus, lastReadAt: now(), readingPosition: null, extractionVersion: expectedVersion + 1,
      extraction: { ...parsed.extraction, previousVersion: expectedVersion } };
    this.transaction(() => {
      this.put('extraction', { id: `${id}:v${expectedVersion}`, documentId: id, version: expectedVersion, document: plain(current), createdAt: now() });
      this.put('extraction', { id: `${id}:v${next.extractionVersion}`, documentId: id, version: next.extractionVersion, document: next, createdAt: now() });
      this.db.prepare('UPDATE documents SET updated=?,body=? WHERE id=?').run(now(), JSON.stringify(next), id);
      this.index('document', id, id, next.name, next.pages.join('\n'));
    });
    this.cache.delete(id);
    return this.getDocument(id);
  }
  extractionVersions(id) {
    const current = this.getDocument(id, false); if (!current) return [];
    const versions = this.list('extraction', id).map(item => ({ ...documentSummary(item.document), current: item.version === current.extractionVersion }));
    if (!versions.some(item => item.extractionVersion === (current.extractionVersion || 1))) versions.push({ ...documentSummary(current), current: true });
    return versions.sort((a, b) => b.extractionVersion - a.extractionVersion);
  }
  listDocuments() { return this.db.prepare('SELECT body FROM documents ORDER BY updated DESC').all().map(row => { const doc = JSON.parse(row.body); return { ...documentSummary(doc), fingerprints: doc.fingerprints, readingStatus: doc.readingStatus, lastReadAt: doc.lastReadAt, readingPosition: doc.readingPosition, extractionVersion: doc.extractionVersion, hasFile: doc.hasFile }; }); }
  touch(id, patch = {}) {
    const doc = this.getDocument(id, false); if (!doc) throw new Error('论文不存在。');
    if (patch.readingStatus && ['unread', 'reading', 'review', 'done'].includes(patch.readingStatus)) doc.readingStatus = patch.readingStatus;
    if (patch.readingPosition) doc.readingPosition = patch.readingPosition;
    doc.lastReadAt = now(); const plain = { ...doc }; delete plain.pdfBuffer;
    this.db.prepare('UPDATE documents SET updated=?,body=? WHERE id=?').run(now(), JSON.stringify(plain), id);
    return { ...documentSummary(doc), readingStatus: doc.readingStatus, readingPosition: doc.readingPosition };
  }
  deleteDocument(id) {
    const doc = this.getDocument(id, false); if (!doc) return;
    this.transaction(() => { const tasks = this.list('task', id); for (const task of tasks) this.db.prepare('DELETE FROM events WHERE task_id=?').run(task.id); this.db.prepare('DELETE FROM records WHERE document_id=?').run(id); this.db.prepare('DELETE FROM search_index WHERE document_id=?').run(id); this.db.prepare('DELETE FROM documents WHERE id=?').run(id); });
    if (this.directory && doc.hasFile) rmSync(join(this.directory, 'files', doc.contentFingerprint), { force: true });
    this.buffers.delete(doc.contentFingerprint); this.cache.delete(id);
  }
  get(kind, id) { if (!id) return null; const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.body) : null; }
  put(kind, item, index = false) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET document_id=excluded.document_id,parent_id=excluded.parent_id,updated=excluded.updated,body=excluded.body').run(kind, item.id, item.documentId || item.document?.id || null, item.parentId || item.conversationId || item.turnId || null, item.updatedAt || now(), JSON.stringify(item));
    if (index) this.index(kind, item.id, item.documentId || item.document?.id, item.title || item.question || '笔记', kind === 'turn' ? [item.question, ...item.answers.map(a => a.text), item.analysis?.text].join('\n') : item.text);
    return item;
  }
  list(kind, documentId = null, parentId = null) {
    const clauses = ['kind=?'], args = [kind];
    if (documentId) { clauses.push('document_id=?'); args.push(documentId); }
    if (parentId) { clauses.push('parent_id=?'); args.push(parentId); }
    return this.db.prepare(`SELECT body FROM records WHERE ${clauses.join(' AND ')} ORDER BY updated DESC`).all(...args).map(row => JSON.parse(row.body));
  }
  remove(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); this.db.prepare('DELETE FROM search_index WHERE kind=? AND id=?').run(kind, id); }
  search(query, documentId = null) {
    query = String(query).trim().slice(0, 200); if (!query) return [];
    const filter = documentId ? ' AND document_id=?' : '', extra = documentId ? [documentId] : [];
    const rows = [...query].length >= 3
      ? this.db.prepare(`SELECT kind,id,document_id,title,body FROM search_index WHERE search_index MATCH ?${filter} LIMIT 50`).all(`"${query.replaceAll('"', '""')}"`, ...extra)
      : this.db.prepare(`SELECT kind,id,document_id,title,body FROM search_index WHERE (instr(lower(title),lower(?))>0 OR instr(lower(body),lower(?))>0)${filter} LIMIT 50`).all(query, query, ...extra);
    return rows.map(row => { const at = row.body.toLowerCase().indexOf(query.toLowerCase()); return { kind: row.kind, id: row.id, documentId: row.document_id, title: row.title, excerpt: row.body.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 220) }; });
  }
  stats() {
    let bytes = 0;
    if (this.directory) for (const file of readdirSync(this.directory)) { const path = join(this.directory, file); if (statSync(path).isFile()) bytes += statSync(path).size; }
    if (this.directory) for (const file of readdirSync(join(this.directory, 'files'))) bytes += statSync(join(this.directory, 'files', file)).size;
    return { bytes, documents: this.listDocuments().length, turns: this.db.prepare("SELECT count(*) AS n FROM records WHERE kind='turn'").get().n, persistent: !!this.directory };
  }
  close() { try { this.db.close(); } finally { this.releaseLock(); } }
}

export class LibraryDocuments {
  constructor(library) { this.library = library; }
  get size() { return this.library.db.prepare('SELECT count(*) AS n FROM documents').get().n; }
  get(id, extractionVersion = null) { return this.library.getDocument(id, true, extractionVersion); }
  set(id, doc) { this.library.addDocument({ ...doc, id }); return this; }
  delete(id) { this.library.deleteDocument(id); }
  *values() { for (const { id } of this.library.listDocuments()) yield this.library.getDocument(id, false); }
  *[Symbol.iterator]() { for (const doc of this.values()) yield [doc.id, doc]; }
}
