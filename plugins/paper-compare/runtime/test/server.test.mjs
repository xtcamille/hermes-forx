import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApplication } from '../server.mjs';
import { normalizeBaseUrl, safeError, chatCompletion } from '../lib/gateway.mjs';
import { samplePdf } from './fixtures.mjs';

test('base URL normalization and credential redaction', () => {
  assert.equal(normalizeBaseUrl('http://models.example:3000/'), 'http://models.example:3000/v1');
  assert.equal(normalizeBaseUrl('http://localhost:3000/v1/chat/completions'), 'http://localhost:3000/v1');
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'));
  assert.throws(() => normalizeBaseUrl('https://name:secret@example.com/'));
  assert.ok(!safeError('upstream sk-dummy-credential-for-redaction-test').includes('sk-123456'));
});

test('local server integration: real parsing, parallel streams, errors, comparison, cancellation and access controls', async t => {
  const requests = []; let active = 0, maxActive = 0, slowClosed = false;
  const gateway = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); }
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input); requests.push(body);
    if (body.model === 'fail') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'temporarily unavailable sk-1234567890123456' } })); }
    if (body.model === 'legacy' && body.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stream is unsupported' } })); }
    if (body.model === 'new-limit' && body.max_tokens) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'max_tokens unsupported; use max_completion_tokens' } })); }
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { content: 'Nonstream answer [P1]' }, finish_reason: 'stop' }], usage: { total_tokens: 20 } })); }
    active++; maxActive = Math.max(maxActive, active);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
    const start = event({ choices: [{ delta: { content: '原文证据 [P1]。' } }] });
    const buffer = Buffer.from(start);
    res.write(buffer.subarray(0, 37)); res.write(buffer.subarray(37));
    if (body.model === 'slow') { res.on('close', () => { active--; slowClosed = true; }); return; }
    const timer = setTimeout(() => {
      res.write(event({ choices: [{ delta: { content: '结论与局限。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }));
      res.end('data: [DONE]\r\n\r\n');
    }, 40);
    res.on('close', () => { clearTimeout(timer); active--; });
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
  const app = createApplication({ baseUrl, apiKey: 'test-gateway-key', pdfParser: 'poppler' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => { app.server.closeAllConnections(); gateway.closeAllConnections(); app.server.close(); gateway.close(); });
  const configResponse = await fetch(`${origin}/api/config`); const config = await configResponse.json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrfToken };
  let doc;
  await t.test('config never returns key and local access rejects hostile origins, hosts and missing CSRF', async () => {
    assert.equal(config.keyConfigured, true); assert.ok(!JSON.stringify(config).includes('test-gateway-key'));
    assert.equal((await fetch(`${origin}/api/demo`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${origin}/api/config`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${origin}/api/config`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.deepEqual((await (await fetch(`${origin}/api/models`)).json()).models, ['model-a', 'model-b']);
  });
  await t.test('PDF upload and source preview keep page labels', async () => {
    const response = await fetch(`${origin}/api/documents`, { method: 'POST', headers: { 'X-CSRF-Token': config.csrfToken, 'X-File-Name': encodeURIComponent('测试论文.pdf') }, body: samplePdf(['Abstract. This study evaluates source-grounded answers.', 'Limitations. The experiment uses a small sample.']) });
    assert.equal(response.status, 201); doc = await response.json(); assert.equal(doc.pages, 2);
    const source = await (await fetch(`${origin}/api/documents/${doc.id}`)).json(); assert.match(source.pages[1].text, /Limitations/);
  });
  await t.test('context preview exposes full coverage without making model calls', async () => {
    const before = requests.length;
    const response = await fetch(`${origin}/api/context-preview`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: 'methods', contextBudget: 250000 }) });
    const data = await response.json(); assert.equal(data.context.mode, 'full'); assert.equal(data.context.selectedPages.length, 2);
    assert.equal(requests.length, before); assert.equal(config.maxContextBudget, 1000000); assert.equal(config.maxOutputTokens, 32768);
  });
  await t.test('two answers really run concurrently with identical prompts, and reviewer gets original evidence', async () => {
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: '有哪些局限？', models: ['model-a', 'model-b'], reviewer: 'model-a' }) });
    const text = await response.text(); assert.match(text, /event: model_delta/); assert.match(text, /event: analysis_done/); assert.match(text, /event: done/);
    assert.ok(maxActive >= 2, 'Requests should overlap');
    const calls = requests.filter(request => request.model === 'model-a' || request.model === 'model-b');
    assert.deepEqual(calls[0].messages, calls[1].messages);
    assert.match(calls[2].messages[1].content, /Limitations/); assert.match(calls[2].messages[1].content, /回答 A/);
    assert.match(text, /"total_tokens":18/);
  });
  await t.test('one model failure does not discard another answer, and errors redact credentials', async () => {
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: 'what are the limitations?', models: ['model-a', 'fail'] }) });
    const text = await response.text(); assert.match(text, /event: model_done/); assert.match(text, /event: model_error/); assert.match(text, /event: analysis_skipped/);
    assert.ok(!text.includes('sk-123456')); assert.match(text, /event: done/);
  });
  await t.test('reviewer retains original answer labels when the middle model fails', async () => {
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: 'check labels', models: ['model-a', 'fail', 'model-b'], reviewer: 'model-a' }) });
    await response.text();
    const reviewerCall = requests.at(-1);
    assert.match(reviewerCall.messages[1].content, /回答 A/);
    assert.match(reviewerCall.messages[1].content, /回答 C/);
    assert.ok(!reviewerCall.messages[1].content.includes('回答 B'));
  });
  await t.test('analysis retry reuses existing answers and makes only one reviewer call', async () => {
    const before = requests.length;
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id, question: 'check retry', models: ['model-a', 'model-b'], reviewer: 'model-a', analysisOnly: true, answers: [
      { model: 'model-a', status: 'done', text: 'Already generated answer A [P1].' },
      { model: 'model-b', status: 'done', text: 'Already generated answer B [P2].' },
    ] }) });
    const text = await response.text(); assert.match(text, /event: analysis_done/); assert.ok(!text.includes('event: model_start'));
    assert.equal(requests.length - before, 1); assert.ok(requests.at(-1).max_tokens >= 6000);
  });
  await t.test('analysis has independent 32k default and accepts a 64k output budget', async () => {
    assert.equal(config.maxAnalysisTokens, 65536); assert.equal(config.defaultAnalysisContextBudget, 500000);
    const data = { documentId: doc.id, question: 'independent analysis limits', models: ['model-a', 'model-b'], reviewer: 'model-a', options: { maxTokens: 2000, analysisMaxTokens: 65536, analysisContextBudget: 800000 } };
    const before = requests.length;
    const text = await (await fetch(`${origin}/api/ask`, { method: 'POST', headers, body: JSON.stringify(data) })).text();
    assert.equal(requests[before].max_tokens, 2000); assert.equal(requests[before + 1].max_tokens, 2000); assert.equal(requests.at(-1).max_tokens, 65536);
    assert.match(text, /"budget":800000/); assert.match(text, /"maxTokens":65536/);
  });
  await t.test('stream-incompatible models and modern token limits adapt without losing responses', async () => {
    const config = { baseUrl, apiKey: 'test-gateway-key' };
    assert.match((await chatCompletion(config, { model: 'legacy', messages: [] })).text, /Nonstream/);
    assert.match((await chatCompletion(config, { model: 'new-limit', messages: [] })).text, /原文证据/);
    assert.ok(requests.find(request => request.model === 'new-limit' && request.max_completion_tokens));
  });
  await t.test('stopping a run closes the upstream request', async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/ask`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ documentId: doc.id, question: 'cancel me', models: ['slow'], analyze: false }) });
    const reader = response.body.getReader();
    while (true) { const chunk = await reader.read(); if (new TextDecoder().decode(chunk.value).includes('model_delta')) break; }
    controller.abort(); await reader.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(slowClosed, true);
  });
  await t.test('expired documents return a clear re-upload error', async () => {
    app.documents.get(doc.id).createdAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
    assert.equal((await fetch(`${origin}/api/documents/${doc.id}`)).status, 404);
  });
});

test('restoring uploaded documents preserves their identity and original pages', () => {
  const document = { id: '12345678-1234-1234-1234-123456789abc', name: 'restored.pdf', sourceType: 'page', pages: ['Original first page.', 'Original last page.'], createdAt: new Date().toISOString() };
  const restored = createApplication({ documents: [document] });
  assert.deepEqual(restored.documents.get(document.id).pages, document.pages);
  assert.equal(restored.documents.get(document.id).id, document.id);
});
