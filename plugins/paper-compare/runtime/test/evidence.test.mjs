import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evidenceCatalogue, sourceEvidence, rememberEvidence, sourcePack, searchEvidence, validBox, parseGapPlan } from '../lib/evidence.mjs';
import { renderRegionImage, locateRegion } from '../lib/regions.mjs';
import { Library } from '../lib/library.mjs';
import { createApplication } from '../server.mjs';
import { layoutPdf } from './fixtures.mjs';

function paper() {
  const pages = ['Introduction only. No reward definition here.', '$$A_i=0\\tag{6}$$\n\nEfficiency reward is zero for unsuccessful trajectories.\n\nGroups with fewer than two successful trajectories receive zero efficiency reward.', '[Image region]\n\nFigure 4. Standard serving and Suffix Cache Reuse.\n\nSCR reuses surviving suffix states.'];
  const blocks = pages.map((text, i) => { let offset = 0; return text.split('\n\n').map((part, j) => { const start = offset; offset += part.length + 2; return { start, end: start + part.length, type: i === 1 && j === 0 ? 'equation' : i === 2 && j === 0 ? 'image' : i === 2 && j === 1 ? 'image_caption' : 'text', boxes: [{ x: .1, y: .08 + j * .13, width: .8, height: .08 }] }; }); });
  return { id: randomUUID(), name: 'evidence-fixture.pdf', pages, chars: pages.join('').length, format: 'pdf', sourceType: 'page', extractionVersion: 2, extraction: { provider: 'mineru' }, sourceBlocks: blocks, createdAt: new Date().toISOString(), pdfBuffer: layoutPdf(pages.map((text, i) => ({ width: i === 1 ? 800 : 612, height: 792, rotate: i === 2 ? 90 : 0, lines: [{ x: 60, y: 710, text: `Page ${i + 1}. Original fixture evidence.` }] }))) };
}
function dimensions(jpeg) {
  let i = 2;
  while (i < jpeg.length) { if (jpeg[i++] !== 255) continue; const marker = jpeg[i++], n = jpeg.readUInt16BE(i); if ([192, 193, 194].includes(marker)) return { width: jpeg.readUInt16BE(i + 5), height: jpeg.readUInt16BE(i + 3) }; i += n; }
  throw new Error('No JPEG dimensions');
}
test('canonical evidence IDs preserve exact source, old anchors and extraction boundaries', () => {
  const doc = paper(), library = new Library();
  const catalogue = evidenceCatalogue(doc); assert.equal(catalogue.objects.length, 2); assert.equal(catalogue.objects[0].label, '公式 6'); assert.equal(catalogue.objects[1].label, '图 4');
  const r = rememberEvidence(library, doc, ['P2.1'], { model: 'A', turnId: 'round-A', role: 'read' })[0];
  assert.equal(r.text, doc.pages[1].slice(r.start, r.end)); assert.equal(sourceEvidence(doc, 'P2.1').id, r.id);
  rememberEvidence(library, doc, ['P2.1'], { model: 'B', turnId: 'round-B', role: 'read' });
  assert.equal(library.list('evidence').length, 1); assert.equal(library.list('evidence-use').length, 2);
  assert.notEqual(sourceEvidence({ ...doc, extractionVersion: 3 }, 'P2.1').id, r.id);
  assert.notEqual(sourceEvidence({ ...doc, id: randomUUID() }, 'P2.1').id, r.id);
  assert.equal(sourceEvidence(doc, 'S2.1').valid, false); assert.equal(sourceEvidence(doc, 'P20.1').valid, false);
  assert.equal(sourcePack([r], r.text.length).provided.length, 0); library.close();
});
test('object captions are not guessed across equally close image regions; invalid boxes fall back to pages', async () => {
  const doc = paper(), text = '[Image one]\n\nFigure 9. Ambiguous figure caption.\n\n[Image two]';
  doc.pages[2] = text; let at = 0; doc.sourceBlocks[2] = text.split('\n\n').map((part,i) => { const start = at; at += part.length + 2; return { start, end: start + part.length, type: i === 1 ? 'image_caption' : 'image', boxes: [{ x: -1, y: .2, width: 5, height: .1 }] }; });
  const objects = evidenceCatalogue(doc).objects.filter(o => o.page === 3); assert.ok(objects.every(o => o.label === '图像区域' && !o.captionRef && !o.region));
  assert.equal((await locateRegion(doc, objects[0])).granularity, 'page'); assert.equal(validBox({ x: 0, y: 0, width: Infinity, height: 1 }), false);
});
test('bounded search locates a Chinese formula request outside its incorrect initial page', () => {
  const doc = paper(), result = searchEvidence(doc, ['解释公式（6）何时为零', 'efficiency reward successful trajectories']);
  assert.equal(result[0].ref, 'P2.1'); assert.ok(result.some(r => r.ref === 'P2.3'));
  const parsed = parseGapPlan('```json\n{"gaps":["conditions"],"queries":["equation 6"],"refs":["P2.1","FAKE"]}\n```'); assert.deepEqual(parsed.refs, ['P2.1']);
  assert.equal(parseGapPlan('not json').malformed, true);
});
test('high resolution crops use original PDF dimensions including rotated and mixed-size pages', async () => {
  const doc = paper(), crop = await renderRegionImage(doc, 2, { x: .1, y: .1, width: .5, height: .1 }), a = dimensions(crop);
  assert.ok(a.width > 2000 && a.width <= 3202); assert.ok(a.height > 400 && a.height < 700);
  const rotated = dimensions(await renderRegionImage(doc, 3, { x: .2, y: .2, width: .5, height: .1 }));
  assert.ok(rotated.width > rotated.height * 3); assert.ok(rotated.width <= 3202);
  await assert.rejects(renderRegionImage(doc, 3, { x: .9, y: 0, width: .5, height: .1 }), /坐标无效/);
});

async function setup(t, options = {}) {
  const calls = [], gateway = http.createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); calls.push(body);
    const system = body.messages[0].content, input = JSON.stringify(body.messages);
    let text;
    if (system.includes('局部精读助手')) text = '对象精读：公式六。\\[ A_i=0 \\]。失败轨迹或成功样本不足两条时为零 [P2.1] [P2.3]。证据缺口：不应外推到未测试数据集。';
    else if (system.includes('证据补查规划助手')) text = options.badPlan ? 'bad planner' : '{"gaps":["缺少公式与成功轨迹条件"],"queries":["equation 6","efficiency reward successful trajectories"],"refs":["P2.1"]}';
    else if (system.includes('证据核验助手')) text = options.insufficient ? '判定：证据不足\n缺少独立实验条件。\n```evidence-gaps\n{"gaps":["仍缺独立实验条件"],"queries":["Figure 4 Suffix Cache Reuse"]}\n```' : input.includes('Groups with fewer than two successful') ? '判定：支持\n公式和条件在 [P2.1] [P2.3]。\n```evidence-gaps\n{"gaps":[],"queries":[]}\n```' : '判定：证据不足\n仅有引言。';
    else text = `独立回答 SECRET_${body.model} [P1.1]。`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({choices:[{delta:{content:text.slice(0, 14)}}]}) + '\n\n');
    const timer = setTimeout(() => { res.write('data: ' + JSON.stringify({ choices:[{delta:{content:text.slice(14)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30} }) + '\n\n'); res.end('data: [DONE]\n\n'); }, system.includes('局部精读助手') ? options.slow || 400 : 5);
    res.once('close', () => clearTimeout(timer));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'evidence-upgrade-')), baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
  const initial = { dataDirectory: directory, cacheDirectory: null, baseUrl, apiKey: 'only-mock-secret', pdfParser: 'poppler', visionCapabilities: { baseUrl, checkedAt: new Date().toISOString(), models: [{ model: 'reader', status: 'supported' }, { model: 'reader2', status: 'supported' }] } };
  const app = createApplication(initial), doc = app.library.addDocument(paper());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const origin = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await (await fetch(origin + '/api/config')).json()).csrfToken;
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(origin + path, {method, headers:{ 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: body === undefined ? undefined : JSON.stringify(body)}), data = await r.json(); if (!r.ok) throw new Error(data.error); return data;
  };
  const finish = async task => { const text = await (await fetch(origin + `/api/runs/${task.id}/events`)).text(); return JSON.parse(text.split('\n').filter(l => l.startsWith('data: ')).at(-1).slice(6)).turn; };
  const read = async task => { const text = await (await fetch(origin + `/api/reading-tasks/${task.id}/events`)).text(); return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))); };
  t.after(async () => { for (const c of app.workspace.active.values()) c.controller.abort(); for (const c of app.workspace.readings.active.values()) c.controller.abort(); gateway.closeAllConnections(); gateway.close(); app.server.closeAllConnections(); app.server.close(); app.library.close(); await rm(directory, { recursive: true, force: true }); });
  return {app,doc,origin,request,finish,read,calls,initial,directory};
}
test('local readings stream, deduplicate repeat clicks and persist a reusable source-only record after restart', async t => {
  const {app,doc,request,read,calls,initial,directory} = await setup(t);
  const body = { documentId: doc.id, extractionVersion: 2, ref: 'P2.1', model: 'reader', requestId: 'same-request' };
  const first = await request('/api/readings', body), same = await request('/api/readings', body); assert.equal(first.id, same.id);
  const connection = await fetch(`http://127.0.0.1:${app.server.address().port}/api/reading-tasks/${first.id}/events`), connectionReader = connection.body.getReader(); await connectionReader.read(); await connectionReader.cancel();
  const states = await read(first), reading = states.at(-1).reading; assert.ok(states.length > 2); assert.ok(states.some(s => s.reading?.text && !s.terminal)); assert.equal(reading.status, 'done'); assert.equal(reading.imageCount, 2); assert.equal(calls.length,1);
  const count = calls.length, again = await read(await request('/api/readings', { ...body, requestId: 'again' })); assert.equal(calls.length, count); assert.ok(again.at(-1).task.cached); assert.equal(again.at(-1).reading.id, reading.id);
  const input = calls.find(c => c.messages[0].content.includes('局部精读助手')); assert.equal(input.messages[1].content.filter(c => c.type === 'image_url').length, 2); assert.deepEqual(reading.inputAudit.history, []); assert.ok(!JSON.stringify(reading).includes('only-mock-secret'));
  const scope = app.workspace.readings.scope({ baseUrl: initial.baseUrl, apiKey: initial.apiKey }, 'reader', sourceEvidence(doc, 'P2.1')); assert.notEqual(scope, app.workspace.readings.scope({baseUrl:initial.baseUrl,apiKey:'changed'},'reader',sourceEvidence(doc,'P2.1')));
  // Opening a second database is safe here: all tasks are terminal.
  const restored = new Library(directory); assert.equal(restored.get('reading', reading.id).text, reading.text); assert.equal(restored.get('reading-cache', scope).readingId, reading.id); restored.close();
});
test('gap-driven verification reads outside the wrong reference, records provenance and never receives other model histories', async t => {
  const {app,doc,request,finish,calls} = await setup(t);
  const turn = await finish(await request('/api/runs',{ documentId: doc.id, question: 'State your own answer.', models: ['A','B'], analyze: false, options: { visionReader: 'reader' } }));
  const before = JSON.stringify(app.library.get('turn', turn.id));
  const claim = await request(`/api/turns/${turn.id}/claims`, { text: 'Efficiency reward for unsuccessful trajectories is zero in equation 6 [P1.1]' });
  const verified = await finish(await request(`/api/turns/${turn.id}/verify`, { claimIds: [claim.id], mode: 'investigate', model: 'A', reader: 'reader' }));
  const v = verified.verifications.at(-1); assert.equal(v.verdict, '支持'); assert.ok(v.pages.includes(2)); assert.ok(v.evidenceIds.length); assert.equal(v.rounds.length, 1); assert.equal(v.readings.length, 1); assert.ok(v.callCount >= 3); assert.deepEqual(v.inputAudit.history, []);
  assert.ok(v.rounds[0].refs.includes('P2.3')); assert.equal(v.readings[0].ref, 'P2.1'); assert.ok(v.rounds[0].candidates.some(c => c.ref.startsWith('P2.')));
  const postCalls = calls.filter(c => /证据补查规划助手|局部精读助手|证据核验助手/.test(c.messages[0].content)); assert.ok(postCalls.every(c => !JSON.stringify(c.messages).includes('SECRET_')));
  const next = await finish(await request('/api/runs', { documentId: doc.id, conversationId: turn.conversationId, parentTurnId: turn.id, question: 'Recall only your answer.', models: ['A','B'], analyze: false }));
  for (const a of next.answers) { const call = calls.filter(c => c.model === a.model && !/证据核验助手|证据补查规划助手|局部精读助手/.test(c.messages[0].content)).at(-1), text = JSON.stringify(call.messages); assert.ok(text.includes(`SECRET_${a.model}`)); assert.ok(!text.includes(`SECRET_${a.model === 'A' ? 'B' : 'A'}`)); assert.ok(!text.includes('对象精读')); }
  assert.equal(JSON.parse(before).answers[0].text, app.library.get('turn', turn.id).answers[0].text);
  assert.ok((await request(`/api/evidence/${v.evidenceIds[0]}`)).evidence.sourceHash);
  const count = calls.filter(c => c.messages[0].content.includes('局部精读助手')).length;
  const reverified = await finish(await request(`/api/turns/${turn.id}/verify`, { claimIds: [claim.id], mode: 'investigate', model: 'A', reader: 'reader' })); assert.equal(calls.filter(c => c.messages[0].content.includes('局部精读助手')).length, count); assert.equal(reverified.verifications.at(-1).readings[0].cached, true); assert.equal(reverified.verifications.at(-1).version, 2);
});
test('unfinished local readings are retained on cancel/restart and never cached as complete evidence', async t => {
  const {app,doc,request,read,directory} = await setup(t,{slow:2000});
  const task = await request('/api/readings',{documentId:doc.id,ref:'P2.1',model:'reader'});
  await new Promise(resolve => setTimeout(resolve, 600)); await request(`/api/reading-tasks/${task.id}/cancel`,{});
  const states = await read(task), reading = states.at(-1).reading; assert.equal(states.at(-1).task.status,'cancelled'); assert.ok(reading.text); assert.equal(app.library.list('reading-cache').length,0);
  app.library.put('reading',{id:'partial-read',documentId:doc.id,status:'running',text:'saved draft',segments:[{status:'running',text:'saved draft'}]}); app.library.put('reading-task',{id:'partial-task',documentId:doc.id,readingId:'partial-read',status:'running',seq:2});
  const restarted = new Library(directory); assert.equal(restarted.get('reading','partial-read').status,'interrupted'); assert.equal(restarted.get('reading-task','partial-task').seq,3); restarted.close();
  await assert.rejects(request('/api/readings',{documentId:doc.id,ref:'P999.2',model:'reader'}),/实际存在/);
  await assert.rejects(request('/api/readings',{documentId:doc.id,ref:'P2.1',model:'unsupported'}),/视觉检测/);
});
test('unresolved gaps stay insufficient, malformed plans degrade to bounded search and budget exhaustion is explicit', async t => {
  const {doc,request,finish} = await setup(t,{insufficient:true,badPlan:true});
  const turn = await finish(await request('/api/runs',{documentId:doc.id,question:'Explain equation 6',models:['A'],analyze:false,options:{visionReader:'reader'}}));
  const claim = await request(`/api/turns/${turn.id}/claims`,{text:'Equation 6 generalizes to an untested dataset [P1.1]'});
  const result = await finish(await request(`/api/turns/${turn.id}/verify`,{claimIds:[claim.id],mode:'investigate',model:'A',reader:'reader'})), v=result.verifications.at(-1);
  assert.equal(v.verdict,'证据不足'); assert.equal(v.rounds.length,2); assert.equal(v.stopReason,'budget_reached'); assert.equal(v.gaps[0],'仍缺独立实验条件'); assert.ok(v.readings.length<=2 && v.pages.length<=6); assert.ok(v.callCount<=5);
  const next = await finish(await request(`/api/turns/${turn.id}/verify`,{claimIds:[claim.id],mode:'investigate',model:'A',reader:'not-verified'})), w=next.verifications.at(-1);
  assert.equal(w.verdict,'证据不足'); assert.equal(w.readings.length,0); assert.match(w.visualLimitation,/只补查提取文字/);
});
test('a shared region read is not cancelled or billed twice when one consuming task stops', async t => {
  const {app,doc,request,finish,read,calls} = await setup(t,{slow:1400});
  const turn=await finish(await request('/api/runs',{documentId:doc.id,question:'Explain equation 6',models:['A'],analyze:false}));
  const local = await request('/api/readings',{documentId:doc.id,ref:'P2.1',model:'reader'});
  const claim=await request(`/api/turns/${turn.id}/claims`,{text:'Efficiency reward for unsuccessful trajectories is zero in equation 6 [P1.1]'});
  const verification=await request(`/api/turns/${turn.id}/verify`,{claimIds:[claim.id],mode:'investigate',model:'A',reader:'reader'});
  for(let i=0;i<100 && ![...app.workspace.readings.jobs.values()].some(j=>j.subscribers.size===2);i++)await new Promise(r=>setTimeout(r,10));
  assert.ok([...app.workspace.readings.jobs.values()].some(j=>j.subscribers.size===2));
  await request(`/api/reading-tasks/${local.id}/cancel`,{}); assert.equal((await read(local)).at(-1).task.status,'cancelled');
  const completed=await finish(verification); assert.equal(completed.verifications.at(-1).status,'done'); assert.equal(completed.verifications.at(-1).verdict,'支持'); assert.equal(calls.filter(c=>c.messages[0].content.includes('局部精读助手')).length,1);
});
test('evidence and reading caches isolate papers and extraction versions without rewriting an earlier turn',async t=>{
  const {app,doc,request,finish,read,calls}=await setup(t);
  const first=await read(await request('/api/readings',{documentId:doc.id,extractionVersion:2,ref:'P2.1',model:'reader'}));
  const turn=await finish(await request('/api/runs',{documentId:doc.id,question:'Keep this turn',models:['A'],analyze:false})), before=JSON.stringify(app.library.get('turn',turn.id));
  const other=paper();other.name='other.pdf';other.pages[0]='Other paper only.';other.pdfBuffer=layoutPdf(other.pages.map((_,i)=>({lines:[{x:60,y:700,text:'Other paper '+i}]})));const second=app.library.addDocument(other);
  await assert.rejects(request('/api/runs',{documentId:second.id,conversationId:turn.conversationId,parentTurnId:turn.id,question:'cross-paper',models:['A']}),/对话与论文不一致/);
  await assert.rejects(request('/api/notes',{documentId:second.id,text:'wrong source',source:{extractionVersion:2,evidenceIds:[first.at(-1).reading.evidenceId]}}),/来源与论文/);
  assert.notEqual(sourceEvidence(second,'P2.1').id,sourceEvidence(doc,'P2.1').id);
  app.library.replaceExtraction(doc.id,{...doc,extraction:{provider:'mineru',version:'next'}},2);
  const count=calls.length, restored=await read(await request('/api/readings',{documentId:doc.id,extractionVersion:2,ref:'P2.1',model:'reader'}));assert.ok(restored.at(-1).task.cached);assert.equal(calls.length,count);
  const fresh=await read(await request('/api/readings',{documentId:doc.id,extractionVersion:3,ref:'P2.1',model:'reader'}));assert.equal(fresh.at(-1).task.cached,false);assert.notEqual(fresh.at(-1).reading.evidenceId,first.at(-1).reading.evidenceId);assert.equal(calls.length,count+1);
  assert.equal(JSON.stringify(app.library.get('turn',turn.id)),before);assert.equal((await request(`/api/documents/${doc.id}?extractionVersion=2`)).pages[1].text,doc.pages[1]);
});
test('reference existence and provided coverage are checked separately from a model verdict',async t=>{
  const {app,doc}=await setup(t),turn=app.workspace.createTurn({documentId:doc.id,question:'Check references',models:['A'],analyze:false});
  const source=rememberEvidence(app.library,doc,['P2.1'])[0],output={...app.workspace.newOutput('A','verification',turn),mode:'text',verdict:'支持',text:'Provided [P2.1]; unread [P3.1]; fabricated [P99.2].',evidenceIds:[source.id]};
  app.workspace.checkVerificationReferences(doc,output,turn);
  assert.deepEqual(output.resultReferences.map(r=>[r.valid,r.provided]),[[true,true],[true,false],[false,false]]);assert.match(output.referenceWarning,/1 处引用不存在/);assert.match(output.referenceWarning,/1 处引用未包含/);assert.equal(output.verdict,'支持');
});
