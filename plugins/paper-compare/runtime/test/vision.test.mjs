import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server.mjs';
import { extractDocument } from '../lib/documents.mjs';
import { renderPageImage, selectVisualPages, verifiedVision, probeVision, discardImages } from '../lib/vision.mjs';
import { samplePdf } from './fixtures.mjs';

test('visual page selection respects manual ranges, coverage limits and figure references', () => {
  const doc = { pdfBuffer: Buffer.from('test'), pages: ['Introduction', 'Figure 1 shows outcomes', 'Methods. L = a + b', 'Figure 2 plots accuracy', 'Limitations'] };
  assert.deepEqual(selectVisualPages(doc, '', { visualSelection: 'manual', visualPages: '2, 3-4, 2' }), [2, 3, 4]);
  assert.deepEqual(selectVisualPages(doc, 'Explain Figure 2', { maxVisualPages: 1 }), [4]);
  assert.deepEqual(selectVisualPages(doc, '', { visualSelection: 'all' }), [1, 2, 3, 4, 5]);
  assert.throws(() => selectVisualPages(doc, '', { visualSelection: 'manual', visualPages: '0,7' }), /范围/);
  assert.throws(() => selectVisualPages({ ...doc, pages: Array(41).fill('') }, '', { visualSelection: 'all' }), /40/);
  assert.throws(() => selectVisualPages({ ...doc, pdfBuffer: null }, '', {}), /重新上传/);
});

test('PDF pages really render into bounded JPEGs and preserve source buffers', async () => {
  const doc = await extractDocument('visual.pdf', samplePdf(['First page with readable formulas and results.', 'Second page chart and table evidence.']));
  const image = await renderPageImage(doc, 2);
  assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8); assert.ok(image.length > 5000);
  assert.equal(await renderPageImage(doc, 2), image);
  await assert.rejects(renderPageImage(doc, 3), /范围/);
  discardImages(doc.id);
});

test('vision verification expires and never infers support from model names', () => {
  const report = { checkedAt: new Date().toISOString(), models: [{ model: 'k3', status: 'supported' }, { model: 'vision-looking-name', status: 'error' }] };
  assert.equal(verifiedVision(report, 'k3'), true); assert.equal(verifiedVision(report, 'vision-looking-name'), false);
  assert.equal(verifiedVision({ ...report, checkedAt: '2020-01-01' }, 'k3'), false);
});

test('shared vision, direct image inputs, scanned PDFs, capability probes and failure isolation', async t => {
  const calls = [];
  const gateway = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: ['vision', 'text', 'bad-vision'].map(id => ({ id })) })); return; }
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input); calls.push(body);
    const content = body.messages.at(-1).content;
    if (body.model === 'unstable-vision' && Array.isArray(content) && content[0].text.includes('第 1 页') && calls.filter(call => call.model === 'unstable-vision' && call.messages[1].content[0].text.includes('第 1 页')).length === 1) { res.destroy(); return; }
    if (body.model === 'bad-vision') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Unsupported image_url parts' } })); return; }
    let text = 'Conclusion from source [P1]. \\(x_i^2\\)';
    if (Array.isArray(content) && content.some(item => item.text?.includes('exact six-character'))) {
      text = body.model === 'text' ? '{"error":"No image was attached"}' : content.find(item => item.type === 'image_url').image_url.url.length > 0 ? calls.filter(call => call.model === 'vision' && Array.isArray(call.messages.at(-1).content) && call.messages.at(-1).content[0].text?.includes('exact six-character')).length % 2 === 1 ? '{"code":"ZR8K2M","highest":"A"}' : '{"code":"TX4N9Q","highest":"B"}' : '';
    } else if (body.messages[0].content.includes('视觉转录助手')) text = '### [P1]\nFigure 1: A=82, B=86, C=91. \\[L=\\frac{1}{N}\\sum_i(y_i-\\hat y_i)^2\\]';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: 200 } }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
  const app = createApplication({ baseUrl, apiKey: 'test-only-secret', pdfParser: 'poppler', cacheDirectory: null, visionCapabilities: { baseUrl, checkedAt: new Date().toISOString(), models: [{ model: 'vision', status: 'supported' }, { model: 'unstable-vision', status: 'supported' }] } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => { app.server.closeAllConnections(); app.server.close(); gateway.closeAllConnections(); gateway.close(); });
  const config = await (await fetch(`${origin}/api/config`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken };
  const upload = async text => (await (await fetch(`${origin}/api/documents`, { method: 'POST', headers: { 'X-CSRF-Token': config.csrfToken, 'X-File-Name': 'visual.pdf' }, body: samplePdf([text]) })).json());
  const doc = await upload('Synthetic study with chart evidence and squared error loss.');
  const ask = async (document, options, models = ['vision', 'text']) => fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: document.id, question: 'Read the chart and formula.', models, reviewer: 'text', options }) });
  await t.test('source preview returns original PDF and rendered page images without exposing credentials', async () => {
    const pdf = await fetch(`${origin}/api/documents/${doc.id}/file`); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /pdf/);
    const image = await fetch(`${origin}/api/documents/${doc.id}/pages/1/image`); assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /jpeg/);
    const source = await (await fetch(`${origin}/api/documents/${doc.id}`)).json(); assert.equal(source.visualAvailable, true); assert.ok(!JSON.stringify(source).includes('pdfBuffer'));
    assert.equal((await fetch(`${origin}/vendor/katex/katex.min.js`)).status, 200);
    assert.equal((await fetch(`${origin}/vendor/katex/fonts/KaTeX_Main-Regular.woff2`)).status, 200);
    assert.equal((await fetch(`${origin}/vendor/../server.mjs`)).status, 404);
  });
  await t.test('shared mode transcribes real images once and gives both models identical visual evidence', async () => {
    const before = calls.length;
    const stream = await (await ask(doc, { visualMode: 'shared', visionReader: 'vision', visualSelection: 'all' })).text();
    assert.match(stream, /event: visual_done/); assert.match(stream, /event: analysis_done/); assert.match(stream, /Figure 1/);
    const requests = calls.slice(before); assert.equal(requests.length, 4);
    const transcription = requests[0].messages[1].content;
    assert.ok(transcription.some(item => item.type === 'image_url' && item.image_url.url.startsWith('data:image/jpeg;base64,')));
    assert.deepEqual(requests[1].messages, requests[2].messages); assert.match(requests[2].messages[1].content, /C=91/);
    assert.match(requests[3].messages[1].content, /视觉转录/);
    const again = calls.length; const cached = await (await ask(doc, { visualMode: 'shared', visionReader: 'vision', visualSelection: 'all' })).text();
    assert.equal(calls.length - again, 3); assert.match(cached, /"cached":true/);
  });
  await t.test('direct mode never silently drops images for unverified models', async () => {
    const before = calls.length;
    const rejected = await ask(doc, { visualMode: 'direct', visualSelection: 'all' }); assert.equal(rejected.status, 400); assert.equal(calls.length, before);
    const text = await (await ask(doc, { visualMode: 'direct', visualSelection: 'all' }, ['vision'])).text();
    assert.match(text, /event: model_done/);
    assert.ok(calls.at(-1).messages[1].content.some(part => part.type === 'image_url'));
  });
  await t.test('analysis retries can reuse visual evidence from history without new transcription', async () => {
    const before = calls.length;
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: 'reuse original evidence', models: ['vision', 'text'], reviewer: 'text', analysisOnly: true,
      options: { visualMode: 'shared', visionReader: 'vision', visualSelection: 'manual', visualPages: '1', analysisMaxTokens: 65536 },
      answers: [{ model: 'vision', status: 'done', text: 'Original chart explanation [P1].' }, { model: 'text', status: 'done', text: 'Original formula explanation [P1].' }],
      visualEvidence: { mode: 'shared', status: 'done', reader: 'vision', pages: [1], notes: 'Saved chart transcript and formula [P1].' },
    }) });
    const stream = await response.text(); assert.match(stream, /"reusedFromHistory":true/); assert.match(stream, /event: analysis_done/);
    assert.equal(calls.length - before, 1); assert.equal(calls.at(-1).max_tokens, 65536); assert.match(calls.at(-1).messages[1].content, /Saved chart transcript/);
  });
  await t.test('a broken page upstream retries once rather than caching partial evidence', async () => {
    const doc = await extractDocument('retry-images.pdf', samplePdf(['First page with methods and visual evidence.', 'Second page with results and figures.'])); app.documents.set(doc.id, doc);
    const before = calls.length;
    const stream = await (await ask(doc, { visualMode: 'shared', visionReader: 'unstable-vision', visualSelection: 'all' })).text();
    assert.match(stream, /"retrying":true/); assert.match(stream, /event: visual_done/); assert.match(stream, /event: analysis_done/);
    const reads = calls.slice(before).filter(call => call.model === 'unstable-vision'); assert.equal(reads.length, 3);
    assert.equal(reads[1].messages[1].content.filter(item => item.type === 'image_url').length, 1);
    assert.equal(reads[2].messages[1].content.filter(item => item.type === 'image_url').length, 1);
  });
  await t.test('scans require visual evidence and shared mode can read image-only papers', async () => {
    const scan = await upload(''); assert.equal(scan.scanned, true);
    assert.equal((await ask(scan, { visualMode: 'off' })).status, 400);
    const text = await (await ask(scan, { visualMode: 'shared', visionReader: 'vision', visualSelection: 'all' })).text();
    assert.match(text, /event: visual_done/); assert.match(text, /event: model_done/);
  });
  await t.test('probes check content twice, detect silently omitted images, and report explicit rejections', async () => {
    const config = { baseUrl, apiKey: 'test-only-secret' };
    assert.equal((await probeVision(config, 'vision')).status, 'supported');
    assert.equal((await probeVision(config, 'text')).status, 'unavailable');
    assert.equal((await probeVision(config, 'bad-vision')).status, 'unsupported');
  });
  await t.test('historical transcripts migrate into per-page cache and only missing pages are read', async () => {
    const doc = await extractDocument('history-migration.pdf', samplePdf(['Original methods and paragraph evidence.', 'Additional results that were not previously transcribed.'])); app.documents.set(doc.id, doc);
    const before = calls.length;
    const imported = await fetch(`${origin}/api/visual-cache/import`, { method: 'POST', headers, body: JSON.stringify({ items: [{ documentId: doc.id, visual: { mode: 'shared', status: 'done', reader: 'vision', pages: [1], notes: '### [P1]\nSaved legacy formula and chart evidence.' } }] }) });
    assert.equal((await imported.json()).importedPages, 1); assert.equal(calls.length, before);
    const stream = await (await ask(doc, { visualMode: 'shared', visionReader: 'vision', visualSelection: 'all' })).text();
    assert.equal(calls.length - before, 4); assert.match(stream, /"cachedPages":\[1\]/); assert.match(stream, /Saved legacy formula/);
  });
  await t.test('changing credentials invalidates visual verification', async () => {
    const response = await fetch(`${origin}/api/config`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'replacement-test-key' }) }); assert.equal(response.status, 200);
    const report = await (await fetch(`${origin}/api/vision`)).json(); assert.deepEqual(report.models, []);
  });
});
