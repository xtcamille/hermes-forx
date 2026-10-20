import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { VisualCache } from '../lib/visual-cache.mjs';
import { visualTranscript } from '../lib/vision.mjs';
import { chatCompletion } from '../lib/gateway.mjs';

test('visual caches isolate changed extraction anchors while preserving existing Poppler cache keys', async () => {
  const cache = new VisualCache(null), config = { baseUrl: 'http://test.invalid/v1', apiKey: 'test-only' };
  const old = { pdfBuffer: Buffer.from('same PDF'), pages: ['Old paragraph anchors.'], extractionVersion: 1 };
  const updated = { ...old, pages: ['New structural anchors.'], extractionVersion: 2 };
  await cache.put(config, 'vision', old, 1, { text: 'Old reference [P1.1].' });
  assert.equal(cache.scope(config, 'vision', old), cache.scope(config, 'vision'));
  assert.equal(await cache.get(config, 'vision', updated, 1), null);
  await cache.put(config, 'vision', updated, 1, { text: 'New reference [P1.2].' });
  assert.match((await cache.get(config, 'vision', old, 1)).text, /Old/);
  assert.match((await cache.get(config, 'vision', updated, 1)).text, /New/);
  assert.equal(await cache.get(config, 'vision', { ...updated, pages: ['Changed extraction text.'] }, 1), null);
});

test('saved page transcripts survive cache instances and identical reuploads without storing keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-cache-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { baseUrl: 'http://test.invalid/v1', apiKey: 'private-test-credential' }, doc = { id: 'old-upload', pdfBuffer: Buffer.from('identical PDF bytes'), pages: ['Evidence text.'] };
  const first = new VisualCache(directory);
  await first.put(config, 'vision-a', doc, 1, { text: 'Equation \\(x_i^2\\) [P1].' });
  const restored = await new VisualCache(directory).get(config, 'vision-a', { ...doc, id: 'new-upload' }, 1);
  assert.match(restored.text, /Equation/);
  assert.equal(await first.get(config, 'vision-b', doc, 1), null);
  assert.equal(await first.get({ ...config, apiKey: 'different-key' }, 'vision-a', doc, 1), null);
  assert.equal(await first.get(config, 'vision-a', doc, 2), null);
  const files = await readdir(directory); assert.equal(files.length, 1);
  assert.ok(!(await readFile(join(directory, files[0]), 'utf8')).includes(config.apiKey));
  await assert.rejects(first.put(config, 'vision-a', doc, 2, { text: 'partial result', finishReason: 'length' }), /未完成/);
});

test('visual transcription streams early, deduplicates concurrent work, saves each page, and reads only missing pages', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-stream-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let finished = 0;
  const gateway = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input); const page = Number(/第 (\d+) 页/.exec(body.messages[1].content[0].text)[1]); calls.push(page);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    event({ choices: [{ delta: { reasoning_content: 'examining chart and formula' } }] });
    event({ choices: [{ delta: { content: `### [P${page}]\nChart first fragment.` } }] });
    setTimeout(() => { finished++; event({ choices: [{ delta: { content: ' Formula \\(y=x^2\\).' }, finish_reason: 'stop' }], usage: { total_tokens: 90 } }); res.end('data: [DONE]\n\n'); }, 80);
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const config = { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, apiKey: 'cache-test-secret' };
  const doc = { id: 'test-document', pdfBuffer: Buffer.from('same content'), pages: ['First paragraph.', 'Second paragraph.'] }, image = page => ({ page, buffer: Buffer.from('fake JPEG input for mock gateway') });
  const cache = new VisualCache(directory); const early = [];
  const results = await Promise.all([
    visualTranscript(config, 'vision', doc, [image(1)], undefined, event => { if (event.type === 'page_delta') early.push(finished); }, { cache }),
    visualTranscript(config, 'vision', doc, [image(1)], undefined, () => {}, { cache }),
  ]);
  assert.deepEqual(calls, [1]); assert.ok(early.includes(0)); assert.equal(results[0].text, results[1].text);
  const expanded = await visualTranscript(config, 'vision', doc, [image(1), image(2)], undefined, () => {}, { cache: new VisualCache(directory) });
  assert.deepEqual(calls, [1, 2]); assert.deepEqual(expanded.cachedPages, [1]); assert.match(expanded.text, /\[P2\]/);
  const allCached = await visualTranscript(config, 'vision', { ...doc, id: 'reuploaded' }, [image(1), image(2)], undefined, () => {}, { cache: new VisualCache(directory) });
  assert.equal(allCached.cached, true); assert.deepEqual(calls, [1, 2]);
});

test('reasoning status is emitted without exposing reasoning text; unfinished streams are rejected', async t => {
  const gateway = http.createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'private model scratchpad', content: 'partial answer' } }] })}\n\n`);
    if (body.model === 'complete') res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); else res.end();
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const config = { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`, apiKey: 'mock-only' }, progress = [];
  const answer = await chatCompletion(config, { model: 'complete', messages: [], onReasoning: update => progress.push(update) });
  assert.equal(answer.streaming, true); assert.ok(progress[0].reasoningChars > 0); assert.ok(!JSON.stringify(progress).includes('scratchpad'));
  await assert.rejects(chatCompletion(config, { model: 'unfinished', messages: [] }), /完成标记/);
});
