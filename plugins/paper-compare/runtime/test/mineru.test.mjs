import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeMineruUrl, pdfParserSettings, mineruHealth, parseMineruPdf, normalizeMineruMiddle } from '../lib/mineru.mjs';
import { extractDocument, pageParagraphs, selectContext } from '../lib/documents.mjs';
import { pageLayout } from '../lib/pdf-layout.mjs';
import { Library } from '../lib/library.mjs';
import { createApplication } from '../server.mjs';
import { samplePdf } from './fixtures.mjs';

const key = 'mineru-test-secret-only';
const golden = JSON.parse(await readFile(new URL('./assets/mineru-fixture-middle.json', import.meta.url), 'utf8'));
const fixture = await readFile(new URL('./assets/visual-fixture.pdf', import.meta.url));
const mathDocument = () => ({ schema: 'docvortex.middle', schema_version: '2.0', is_full_document: true,
  metadata: { document: { title: 'Synthetic formula and table', page_count: 3 } },
  extensions: { mineru: { parse_mode: 'txt' } }, pages: [
    { page_idx: 0, blocks: [
      { type: 'text', bbox: [.1, .1, .8, .2], content: [{ type: 'text', content: 'For ' }, { type: 'equation_inline', content: 'x_i' }, { type: 'text', content: ', keep both surrounding spaces.' }] },
      { type: 'equation', bbox: [.2, .25, .7, .35], content: String.raw`L=\frac{1}{N}\sum_i(y_i-\hat y_i)^2\tag{1}` },
      { type: 'table', bbox: [.1, .4, .8, .6], content: [
        { type: 'table_body', bbox: [.1, .4, .8, .55], content: '<table><tr><th>Method</th><th>Accuracy</th></tr><tr><td>A</td><td>82%</td></tr><tr><td>B</td><td>91%</td></tr></table>' },
        { type: 'table_caption', bbox: [.1, .56, .8, .6], content: [{ type: 'text', content: 'Table 1. Synthetic results.' }] }
      ] },
      { type: 'image', bbox: [.1, .65, .8, .8], content: [{ type: 'image_body', bbox: [.1, .65, .8, .8], content: '' }], image_source: 'data:image/png;base64,SHOULD_NEVER_ENTER_CONTEXT' }
    ] },
    { page_idx: 1, blocks: [] },
    { page_idx: 2, blocks: [{ type: 'text', bbox: [-1, 0, 9, 4], content: [{ type: 'text', content: 'Limitations require checking the original source.' }] }] }
  ] });

async function mockMineru(t, options = {}) {
  const requests = [], uploads = [], jobs = []; let polls = 0;
  const middle = options.middle || golden;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), body = req.headers['content-type']?.includes('application/json') && bytes.length ? JSON.parse(bytes) : null;
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body, bytes });
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/health') return json({ status: 'ok', version: '4.0.0', features: { sources: ['file_id'], output_formats: ['markdown', 'middle_json'] } });
    if (req.url === '/v1/uploads' && req.method === 'POST') {
      uploads.push(body);
      return json(options.cached ? { id: 'upload_1', status: 'completed', file: { id: 'file-input' } } : { id: 'upload_1', status: 'pending', upload_url: options.uploadUrl || '/v1/uploads/upload_1/content', upload_method: 'PUT', upload_headers: { 'Content-Type': 'application/pdf', 'X-Upload-Signature': 'test-signature' } });
    }
    if (req.url === '/v1/uploads/upload_1/content') return json({ uploaded: true });
    if (req.url === '/v1/uploads/upload_1/complete') return json({ id: 'upload_1', status: 'completed', file: { id: 'file-input' } });
    const result = status => ({ job_id: 'job_test', status, tier: 'standard', files: [{ file_id: 'file-input', name: 'fixture.pdf', status: status === 'completed' ? 'completed' : 'queued', parse: { parser_version: '4.0.0', duration_ms: 123 }, output_files: status === 'completed' ? { middle_json: { file_id: 'file-result', bytes: 1000 } } : null, error: status === 'failed' ? { message: 'test failed ' + key } : null }] });
    if (req.url === '/v1/parse/jobs' && req.method === 'POST') { jobs.push(body); polls = 0; return json(result(options.badStatus ? 'unknown' : 'queued')); }
    if (req.url === '/v1/parse/jobs/job_test') return json(result(options.terminal || (options.never || polls++ === 0 ? 'running' : 'completed')));
    if (req.url === '/v1/files/file-result/content') {
      if (options.redirect) { res.writeHead(302, { Location: options.redirect }); return res.end(); }
      if (options.badArtifact) { res.writeHead(200); return res.end('not JSON'); }
      return json(middle);
    }
    return json({ error: { message: 'Unexpected path' } }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { server, baseUrl, requests, uploads, jobs, settings: { provider: 'mineru', baseUrl, tier: 'standard', apiKey: key, pollIntervalMs: 10, timeoutMs: 5000 } };
}

test('MinerU configuration separates parser credentials and accepts the supplied health URL', () => {
  assert.equal(normalizeMineruUrl('http://mineru.example:8000/v1/health'), 'http://mineru.example:8000/v1');
  assert.equal(normalizeMineruUrl('http://mineru.example:8000/'), 'http://mineru.example:8000/v1');
  assert.equal(pdfParserSettings({ provider: 'mineru' }).provider, 'mineru');
  for (const url of ['file:///tmp/file', 'http://user:secret@example.com', 'https://example.com?key=secret']) assert.throws(() => normalizeMineruUrl(url));
  assert.throws(() => pdfParserSettings({ tier: 'invented' }));
});

test('actual MinerU 4.0 fixture preserves physical pages, captions and image-only limitations', () => {
  const doc = normalizeMineruMiddle(golden, { pageCount: 2, requireFull: true });
  assert.equal(doc.pages.length, 2); assert.match(doc.pages[0], /CODE: ZR8K2M/);
  assert.match(doc.pages[0], /Figure 1/); assert.match(doc.pages[0], /需通过原图读取或核验/);
  assert.match(doc.pages[1], /not a real research paper/);
  assert.deepEqual(doc.stats, { equations: 0, tables: 0, figures: 1 });
  assert.ok(!JSON.stringify(doc).includes('base64')); assert.ok(doc.sourceBlocks[0].every(block => block.boxes.length));
});

test('normalization retains inline spacing, LaTeX, table relationships, empty pages and original anchors', async () => {
  const parsed = normalizeMineruMiddle(mathDocument(), { pageCount: 3, requireFull: true });
  const doc = { ...parsed, sourceType: 'page', extractionVersion: 2, extraction: { provider: 'mineru' } };
  assert.match(doc.pages[0], /For \$x_i\$, keep both surrounding spaces\./);
  assert.match(doc.pages[0], /\\frac\{1\}\{N\}/); assert.match(doc.pages[0], /\| B \| 91% \|/);
  assert.equal(doc.pages[1], ''); assert.match(doc.pages[2], /Limitations/);
  assert.deepEqual(doc.stats, { equations: 1, tables: 1, figures: 1 });
  assert.ok(!JSON.stringify(doc).includes('SHOULD_NEVER_ENTER_CONTEXT'));
  const paragraphs = pageParagraphs(doc, 0); assert.ok(paragraphs.length >= 5);
  for (const part of paragraphs) assert.equal(doc.pages[0].slice(part.start, part.end), part.text);
  assert.match(selectContext(doc, 'formula').text, /\[P3\.1\]/);
  const layout = await pageLayout(doc, 1); assert.equal(layout.granularity, 'block'); assert.ok(layout.paragraphs.every(part => part.located));
  const invalid = await pageLayout(doc, 3); assert.equal(invalid.paragraphs[0].located, false); assert.deepEqual(invalid.paragraphs[0].boxes, []);
  const missingBlank = mathDocument(); missingBlank.pages.splice(1, 1); assert.equal(normalizeMineruMiddle(missingBlank).pages[1], '');
});

test('merged HTML table cells stay aligned and entities do not become executable markup', () => {
  const middle = mathDocument(); middle.pages[0].blocks = [{ type: 'table', bbox: [0, 0, 1, 1], content: [{ type: 'table_body', content: '<table><tr><td rowspan="2">Method</td><td colspan="2">Scores</td></tr><tr><td>&#65;</td><td>91 &amp; 92</td></tr></table>' }] }];
  const doc = normalizeMineruMiddle(middle);
  assert.match(doc.pages[0], /\| Method \| Scores \| Scores \|/);
  assert.match(doc.pages[0], /\| Method \| A \| 91 & 92 \|/);
});

test('MinerU completes byte upload, polling, artifact download and source normalization', async t => {
  const api = await mockMineru(t, { middle: mathDocument() });
  const pdf = samplePdf(['Native formula text', '', 'Limitations and source evidence.']);
  const health = await mineruHealth(api.settings); assert.equal(health.status, 'ok'); assert.ok(!JSON.stringify(health).includes(key));
  const doc = await extractDocument('real-upload.pdf', pdf, api.settings);
  assert.equal(doc.extraction.provider, 'mineru'); assert.equal(doc.extractionVersion, 2); assert.equal(doc.pages.length, 3);
  assert.match(doc.pages[0], /\\hat y_i/); assert.deepEqual(doc.pdfBuffer, pdf);
  assert.equal(api.uploads[0].sha256sum, createHash('sha256').update(pdf).digest('hex'));
  assert.deepEqual(api.requests.find(r => r.method === 'PUT').bytes, pdf);
  assert.ok(api.requests.every(r => r.auth === `Bearer ${key}`));
  assert.equal(api.jobs.length, 1); assert.equal(api.jobs[0].files[0].source.file_id, 'file-input');
  assert.deepEqual(api.jobs[0].output_formats, ['middle_json']);
});

test('reparse endpoint archives the old extraction and concurrent retries create only one MinerU job', async t => {
  const mineru = await mockMineru(t), old = await extractDocument('fixture.pdf', fixture, {provider:'poppler'});
  const app = createApplication({pdfParser:mineru.settings,documents:[old],cacheDirectory:null});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(() => {app.server.closeAllConnections();app.server.close();app.library.close();});
  const root=`http://127.0.0.1:${app.server.address().port}`, config=await fetch(root+'/api/config').then(r=>r.json());
  const reparse = () => fetch(root+`/api/documents/${old.id}/reparse`, {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':config.csrfToken},body:JSON.stringify({expectedVersion:1})}).then(async r=>({status:r.status,body:await r.json()}));
  const replies = await Promise.all([reparse(),reparse()]);
  assert.ok(replies.every(r=>r.status===200 && r.body.extractionVersion===2)); assert.equal(mineru.jobs.length,1);
  const historical=await fetch(root+`/api/documents/${old.id}?extractionVersion=1`).then(r=>r.json());
  assert.equal(historical.pages[0].text,old.pages[0]); assert.equal(historical.currentExtractionVersion,2);
  assert.equal((await reparse()).body.reused,true); assert.equal(mineru.jobs.length,1);
  const current=await fetch(root+`/api/documents/${old.id}`).then(r=>r.json());
  assert.equal(current.extraction.provider,'mineru');assert.match(current.pages[0].text,/CODE: ZR8K2M/);
});

test('MinerU cached upload skips byte transfer, and cross-origin artifact redirects never forward the API key', async t => {
  let redirectedAuth = 'unobserved';
  const download = http.createServer((req, res) => { redirectedAuth = req.headers.authorization; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(golden)); });
  download.listen(0, '127.0.0.1'); await once(download, 'listening');
  t.after(() => { download.closeAllConnections(); download.close(); });
  const api = await mockMineru(t, { cached: true, redirect: `http://127.0.0.1:${download.address().port}/signed-output` });
  const result = await parseMineruPdf('fixture.pdf', fixture, { ...api.settings, pageCount: 2 });
  assert.equal(result.pages.length, 2); assert.equal(redirectedAuth, undefined);
  assert.equal(api.requests.filter(r => r.method === 'PUT').length, 0);
  assert.equal(api.requests.filter(r => r.path.endsWith('/complete')).length, 0);
});

test('cross-origin presigned upload preserves server headers without attaching the MinerU key', async t => {
  let uploadAuth = 'unobserved', uploadSignature;
  const upload = http.createServer(async (req, res) => { uploadAuth = req.headers.authorization; uploadSignature = req.headers['x-upload-signature']; for await (const _ of req) {} res.end('{}'); });
  upload.listen(0, '127.0.0.1'); await once(upload, 'listening');
  t.after(() => { upload.closeAllConnections(); upload.close(); });
  const api = await mockMineru(t, { uploadUrl: `http://127.0.0.1:${upload.address().port}/signed-upload` });
  await parseMineruPdf('fixture.pdf', fixture, { ...api.settings, pageCount: 2 });
  assert.equal(uploadAuth, undefined); assert.equal(uploadSignature, 'test-signature');
});

test('invalid, partial and failed jobs never become accepted documents; errors redact parser keys', async t => {
  for (const options of [{ badStatus: true }, { terminal: 'partial' }, { terminal: 'failed' }, { badArtifact: true }]) {
    const api = await mockMineru(t, options);
    await assert.rejects(parseMineruPdf('fixture.pdf', fixture, api.settings), error => { assert.ok(!error.message.includes(key)); return /MinerU/.test(error.message); });
    assert.equal(api.jobs.length, 1);
  }
  const partial = mathDocument(); partial.is_full_document = false; assert.throws(() => normalizeMineruMiddle(partial, { requireFull: true }), /完整论文/);
  const duplicate = mathDocument(); duplicate.pages.push(duplicate.pages[0]); assert.throws(() => normalizeMineruMiddle(duplicate), /重复/);
  assert.throws(() => normalizeMineruMiddle(mathDocument(), { pageCount: 2 }), /页数/);
  assert.throws(() => normalizeMineruMiddle({ schema: 'unknown', pages: [] }), /结构不受支持/);
});

test('a parsing timeout retains the remote job identity without resubmitting', async t => {
  const api = await mockMineru(t, { cached: true, never: true });
  await assert.rejects(parseMineruPdf('fixture.pdf', fixture, { ...api.settings, timeoutMs: 500 }), /job_test.*未自动重复提交/);
  assert.equal(api.jobs.length, 1);
});

test('server imports via MinerU once, keeps old extraction identities, and restores parser results offline', async t => {
  const api = await mockMineru(t);
  const directory = await mkdtemp(join(tmpdir(), 'paper-mineru-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApplication({ pdfParser: api.settings, apiKey: 'separate-llm-secret', dataDirectory: directory, cacheDirectory: null });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => { app.server.closeAllConnections(); app.server.close(); app.library.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.pdfParser.provider, 'mineru'); assert.ok(!JSON.stringify(config).includes(key)); assert.ok(!JSON.stringify(config).includes('separate-llm-secret'));
  const upload = () => fetch(origin + '/api/documents', { method: 'POST', headers: { 'X-File-Name': 'fixture.pdf', 'X-CSRF-Token': config.csrfToken }, body: fixture });
  const responses = await Promise.all([upload(), upload()]);
  assert.ok(responses.every(r => r.status === 201));
  const docs = await Promise.all(responses.map(r => r.json())); assert.equal(docs[0].id, docs[1].id); assert.equal(api.jobs.length, 1);
  const duplicate = await (await upload()).json(); assert.equal(duplicate.reused, true); assert.equal(duplicate.id, docs[0].id); assert.equal(api.jobs.length, 1);
  const source = await (await fetch(origin + '/api/documents/' + duplicate.id)).json(); assert.equal(source.pages[1].number, 2); assert.match(source.pages[1].text, /Limitations/);
  const layout = await (await fetch(origin + `/api/documents/${duplicate.id}/pages/1/layout`)).json(); assert.equal(layout.provider, 'mineru'); assert.ok(layout.paragraphs.every(p => p.located));
  const visual = { mode: 'shared', status: 'done', reader: 'vision', pages: [1], notes: 'Cached reference [P1.1].' };
  const importVisual = item => fetch(origin + '/api/visual-cache/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken }, body: JSON.stringify({ items: [item] }) }).then(r => r.json());
  assert.equal((await importVisual({ documentId: duplicate.id, visual })).importedPages, 0);
  assert.equal((await importVisual({ documentId: duplicate.id, extractionVersion: 2, visual })).importedPages, 1);
  const oldPdf = samplePdf(['Existing paper with immutable paragraph references.']);
  const old = await extractDocument('old.pdf', oldPdf); app.library.addDocument(old, oldPdf);
  const oldResponse = await fetch(origin + '/api/documents', { method: 'POST', headers: { 'X-File-Name': 'old.pdf', 'X-CSRF-Token': config.csrfToken }, body: oldPdf });
  const existing = await oldResponse.json(); assert.equal(existing.id, old.id); assert.equal(existing.extractionVersion, 1); assert.equal(existing.extraction.provider, 'poppler'); assert.equal(api.jobs.length, 1);
  const orphanPdf = samplePdf(['Historical original with stable paragraph citations.']);
  app.library.put('turn', { id: 'legacy-turn-without-file', documentId: 'missing-document', document: { id: 'missing-document', fingerprint: createHash('sha256').update(orphanPdf).digest('hex'), extractionVersion: 1 }, question: 'Historical question', answers: [], analysis: null });
  const orphanResponse = await fetch(origin + '/api/documents', { method: 'POST', headers: { 'X-File-Name': 'restored-old.pdf', 'X-CSRF-Token': config.csrfToken }, body: orphanPdf });
  const restoredOld = await orphanResponse.json(); assert.equal(restoredOld.extractionVersion, 1); assert.equal(restoredOld.extraction.provider, 'poppler'); assert.equal(api.jobs.length, 1);
  assert.equal(app.library.get('turn', 'legacy-turn-without-file').document.id, restoredOld.id);
  const library = new Library(directory); t.after(() => library.close());
  const restored = library.getDocument(duplicate.id); assert.equal(restored.extraction.provider, 'mineru'); assert.equal(restored.extractionVersion, 2); assert.deepEqual(restored.pages, source.pages.map(p => p.text));
  assert.ok(restored.pdfBuffer); assert.ok((await pageLayout(restored, 1)).paragraphs.every(p => p.located));
});
