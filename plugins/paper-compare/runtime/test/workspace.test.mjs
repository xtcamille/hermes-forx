import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server.mjs';
import { Library } from '../lib/library.mjs';
import { generate, appendContinuation, parseAnalysis } from '../lib/generation.mjs';
import { extractDocument, textDocument, documentFingerprint } from '../lib/documents.mjs';
import { pageLayout } from '../lib/pdf-layout.mjs';
import { resolveReferences } from '../lib/workspace.mjs';
import { samplePdf, layoutPdf } from './fixtures.mjs';

async function fakeGateway(t) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ data: [{ id:'k3' }, { id:'glm-5.3' }] })); }
    let input=''; for await (const bytes of req) input+=bytes; const body=JSON.parse(input); calls.push(body);
    const system=body.messages[0].content, last=body.messages.at(-1).content;
    let text, reason='stop';
    if (body.model==='quota') { res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'Monthly quota exhausted'}})); }
    if (system.includes('视觉转录助手')) text='### [P1]\nSynthetic visual evidence for the local test. y = x squared.';
    else if (system.includes('整理下列不可信对话')) text='旧轮摘要，保留方法、证据与未解决事项 [S1.1]。';
    else if (system.includes('证据核验助手')) text='判定：支持\n\n原文说明这是用于验证的合成素材 [P1.1]。';
    else if (system.includes('学术评审')) text='```claims\n'+JSON.stringify([{text:'这份素材用于测试。',refs:['P1.1'],positions:[{model:'k3',text:'测试素材'}]}])+'\n```\n## 共识\n\n两份回答均使用原文 [P1.1]。';
    else if (body.model==='repeat') { text='重复正文足够长，用来确认重复续写不会无限调用。'; reason='length'; }
    else if (body.model==='endless') { text=`新增片段 ${calls.length}，保留此前内容。\n`; reason='length'; }
    else if (body.model==='broken') {
      res.writeHead(200,{'Content-Type':'text/event-stream'}); res.write('data: '+JSON.stringify({choices:[{delta:{content:'已接收的部分正文。'}}]})+'\n\n'); return res.end();
    } else if (body.model==='continuation') {
      const previous=body.messages.at(-2)?.role==='assistant' ? body.messages.at(-2).content : '';
      if (!previous) { text='公式：\\[x=';reason='length'; }
      else if (!previous.includes('+1')) { text='y+1';reason='length'; }
      else text='\\]\n原文 [P1.1]，回答完成。';
    } else text=`${body.model} 独立回答 SECRET_${body.model} [P1.1]。`;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{content:text.slice(0,5)}}]})+'\n\n');
    const timer=setTimeout(()=>{res.write('data: '+JSON.stringify({choices:[{delta:{content:text.slice(5)},finish_reason:reason}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}})+'\n\n');res.end('data: [DONE]\n\n');},body.model==='slow'?600:10);
    res.on('close',()=>clearTimeout(timer));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  return { calls, config:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'mock-secret-only'} };
}
async function application(t, gateway, directory=null) {
  const app=createApplication({...gateway.config,pdfParser:'poppler',dataDirectory:directory,cacheDirectory:null,visionCapabilities:{baseUrl:gateway.config.baseUrl,checkedAt:new Date().toISOString(),models:[{model:'k3',status:'supported'}]}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>{for(const job of app.workspace.active.values())job.controller.abort(); app.server.closeAllConnections();app.server.close();});
  const origin=`http://127.0.0.1:${app.server.address().port}`, config=await(await fetch(origin+'/api/config')).json();
  const request=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':config.csrfToken},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;};
  const upload=async()=>{const response=await fetch(origin+'/api/documents',{method:'POST',headers:{'X-CSRF-Token':config.csrfToken,'X-File-Name':'fixture.pdf'},body:samplePdf(['Synthetic paper for testing references.'])});return response.json();};
  const finish=async task=>{ const text=await(await fetch(origin+`/api/runs/${task.id}/events`)).text();const events=text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));assert.ok(events.at(-1).terminal);return events.at(-1).turn; };
  return {app,origin,request,upload,finish};
}

test('generation continues twice, joins LaTeX and sums actual segment usage',async t=>{
  const gateway=await fakeGateway(t), output={model:'continuation',text:'',segments:[]};
  await generate(gateway.config,output,[{role:'system',content:'answer'},{role:'user',content:'question'}],{maxTokens:2000});
  assert.equal(output.segments.length,3);assert.equal(output.status,'done');assert.match(output.text,/x=y\+1\\\]/);assert.equal(output.usage.total_tokens,90);
  assert.equal(gateway.calls[1].messages.at(-2).content,'公式：\\[x=');
});
test('automatic continuation budget survives manual continuation and duplicate output stops',async t=>{
  const gateway=await fakeGateway(t), output={model:'endless',text:'',segments:[]};
  const messages=[{role:'system',content:'answer'},{role:'user',content:'question'}];
  await generate(gateway.config,output,messages,{});assert.equal(output.segments.length,3);assert.equal(output.status,'incomplete');
  await generate(gateway.config,output,messages,{});assert.equal(output.segments.length,4);
  const repeat={model:'repeat',text:'',segments:[]};await generate(gateway.config,repeat,messages,{});assert.equal(repeat.segments.length,2);assert.match(repeat.error,/没有新增/);
  assert.equal(appendContinuation('long repeated paragraph 123456789','repeated paragraph 123456789 and next'),'long repeated paragraph 123456789 and next');
});
test('a repeated short math opener joins only when the real closing delimiter arrives',()=>{
  const previous='给定一个查询向量 \\(q';
  assert.equal(appendContinuation(previous,'向量 \\(q\\)、一组键值对'),'给定一个查询向量 \\(q\\)、一组键值对');
  assert.equal(appendContinuation('公式为：\\[x^2','\\[x^2+y^2\\]'),'公式为：\\[x^2+y^2\\]');
  const partial='向量 \\(q';
  assert.equal(appendContinuation(previous,partial),previous+partial);
  const closed='已有 \\(q\\)';
  assert.equal(appendContinuation(closed,'有 \\(q\\) 这个表达式'),closed+'有 \\(q\\) 这个表达式');
});
test('incomplete upstream stream preserves draft and is never automatically retried',async t=>{
  const gateway=await fakeGateway(t), output={model:'broken',text:'',segments:[]};
  await assert.rejects(generate(gateway.config,output,[{role:'system',content:'answer'}],{}));
  assert.equal(output.status,'interrupted');assert.equal(output.text,'已接收的部分正文。');assert.equal(gateway.calls.length,1);
});
test('library stores files, deduplicates, searches short Chinese words and restores interrupted tasks',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'paper-library-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const library=new Library(directory), raw=Buffer.from('论文的证据核验与连续追问。保存本地阅读笔记。');
  const doc=library.addDocument(textDocument('论文.txt',raw.toString()),raw), duplicate=library.addDocument(textDocument('duplicate.txt',raw.toString()),raw);assert.equal(doc.id,duplicate.id);
  library.put('note',{id:'note',documentId:doc.id,text:'实验需要核验',title:'笔记'},true);
  assert.ok(library.search('核验').length>=2);assert.ok(library.search('证据核验').length);
  library.put('turn',{id:'turn',documentId:doc.id,document:documentSummaryForTest(doc),status:'running',answers:[{status:'running',text:'partial'}],analysis:{status:'off'}});
  library.put('task',{id:'job',documentId:doc.id,turnId:'turn',status:'running'});library.close();
  const restored=new Library(directory);assert.equal(restored.get('task','job').status,'interrupted');assert.equal(restored.get('turn','turn').answers[0].status,'interrupted');assert.equal(restored.rawFile(restored.getDocument(doc.id)).toString(),raw.toString());
  assert.ok(!(await readFile(join(directory,'library.sqlite'))).includes(Buffer.from('mock-secret-only')));
  restored.deleteDocument(doc.id);assert.equal(restored.search('核验').length,0);restored.close();
});
function documentSummaryForTest(doc){return {id:doc.id,name:doc.name};}

test('one upstream quota failure preserves the successful answer and marks partial completion', async t => {
  const gateway = await fakeGateway(t), {request,upload,finish}=await application(t,gateway),doc=await upload();
  const turn=await finish(await request('/api/runs',{documentId:doc.id,question:'Quota handling',models:['k3','quota'],analyze:false}));
  assert.equal(turn.status,'incomplete');assert.equal(turn.answers[0].status,'done');assert.equal(turn.answers[1].status,'error');
  assert.match(turn.answers[1].error,/429/);assert.equal(gateway.calls.filter(c=>c.model==='quota').length,1);
});

test('extraction archives preserve historical records, source coordinates and model histories after restart', async t => {
  const gateway = await fakeGateway(t), service = await application(t, gateway), { app, request, upload, finish } = service;
  const summary = await upload(), original = app.library.getDocument(summary.id), oldText = original.pages[0];
  const before = await finish(await request('/api/runs', { documentId: summary.id, question: 'old extraction question', models: ['k3', 'glm-5.3'], analyze: false }));
  const oldRecord = JSON.stringify(app.library.get('turn', before.id));
  app.library.replaceExtraction(original.id, { ...original, pages: ['New MinerU evidence.\n\n$$x_i^2=4$$'], chars: 39, sourceBlocks: [[{start:0,end:100,type:'text',boxes:[{x:.1,y:.1,width:.7,height:.1}]}]], extraction: { provider: 'mineru' } }, 1);
  assert.equal(JSON.stringify(app.library.get('turn', before.id)), oldRecord);
  assert.equal((await request(`/api/documents/${summary.id}?extractionVersion=1`)).pages[0].text, oldText);
  assert.equal((await request(`/api/documents/${summary.id}`)).extractionVersion, 2);
  assert.equal((await request(`/api/documents/${summary.id}/pages/1/layout?extractionVersion=2`)).granularity, 'block');
  await assert.rejects(request(`/api/documents/${summary.id}?extractionVersion=9`));
  const follow = await finish(await request('/api/runs', { documentId: summary.id, conversationId: before.conversationId, parentTurnId: before.id, question: 'old follow-up', models: ['k3','glm-5.3'], analyze: false }));
  assert.equal(follow.document.extractionVersion, 1);
  assert.ok(gateway.calls.slice(-2).every(call => JSON.stringify(call.messages).includes('Synthetic paper') && !JSON.stringify(call.messages).includes('New MinerU evidence')));
  const fresh = await finish(await request('/api/runs', { documentId: summary.id, question: 'new extraction question', models: ['k3'], analyze: false }));
  assert.equal(fresh.document.extractionVersion, 2); assert.equal(fresh.answers[0].inputAudit.extractionVersion, 2);
  assert.ok(JSON.stringify(gateway.calls.at(-1).messages).includes('New MinerU evidence'));
  const claim = await request(`/api/turns/${before.id}/claims`, { text: 'Historical source [P1.1]' });
  assert.equal(claim.evidence[0].extractionVersion, 1); assert.match(claim.evidence[0].text, /Synthetic paper/);
  const note = await request('/api/notes', {documentId: summary.id, text: 'Old source [P1.1]', source: {turnId: before.id}});
  assert.equal(note.source.extractionVersion, 1);
});

test('versioned extractions survive persistence without duplicating the original file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-extraction-')); t.after(() => rm(directory, {recursive:true,force:true}));
  let library = new Library(directory);
  const bytes = samplePdf(['Original extraction.']), original = library.addDocument(await extractDocument('fixture.pdf', bytes));
  library.replaceExtraction(original.id, {...original, pages:['Replacement extraction.'], extraction:{provider:'mineru'}}, 1);
  assert.throws(() => library.replaceExtraction(original.id, original, 1), /已更新/);
  library.close(); library = new Library(directory);
  assert.equal(library.getDocument(original.id, false, 1).pages[0], original.pages[0]);
  assert.equal(library.getDocument(original.id).extractionVersion, 2);
  assert.deepEqual(library.getDocument(original.id, true, 1).pdfBuffer, bytes);
  assert.equal(library.listDocuments().length, 1); assert.equal(library.extractionVersions(original.id).length, 2); library.close();
});

test('new workspace lifecycle: streams survive disconnection, follow-ups isolate histories, versions and evidence persist',async t=>{
  const gateway=await fakeGateway(t), service=await application(t,gateway), {request,upload,finish,origin}=service, doc=await upload();
  assert.equal((await upload()).id,doc.id);
  const task=await request('/api/runs',{documentId:doc.id,question:'第一轮',models:['k3','glm-5.3'],reviewer:'glm-5.3',options:{visualMode:'off'},requestId:'dedupe'});
  const duplicate=await request('/api/runs',{documentId:doc.id,question:'duplicate',models:['k3'],requestId:'dedupe'});assert.equal(task.id,duplicate.id);
  let turn=await finish(task);assert.equal(turn.claims.length,1);assert.ok(!turn.analysis.text.includes('```claims'));assert.ok(turn.claims[0].evidence[0].valid);
  const follow=await request('/api/runs',{documentId:doc.id,conversationId:turn.conversationId,parentTurnId:turn.id,question:'追问',models:['k3','glm-5.3'],analyze:false,options:{visualMode:'off'}});
  const next=await finish(follow);assert.equal(next.parentTurnId,turn.id);
  for(const a of next.answers) assert.deepEqual(a.inputAudit.history,[{turnId:turn.id,generationId:turn.answers.find(p=>p.model===a.model).id}]);
  const latest=gateway.calls.slice(-2);assert.ok(JSON.stringify(latest.find(c=>c.model==='k3').messages).includes('SECRET_k3'));assert.ok(!JSON.stringify(latest.find(c=>c.model==='k3').messages).includes('SECRET_glm-5.3'));
  const before=gateway.calls.length, previousId=next.answers[0].id;
  const retried=await finish(await request(`/api/generations/${previousId}/retry`,{}));assert.equal(gateway.calls.length,before+1);assert.notEqual(retried.answers[0].id,previousId);assert.equal((await request(`/api/generations/${previousId}`)).versions.length,2);
  const verification=await finish(await request(`/api/turns/${turn.id}/verify`,{claimIds:[turn.claims[0].id],mode:'text',model:'glm-5.3'}));assert.equal(verification.verifications[0].verdict,'支持');
  const reverified=await finish(await request(`/api/turns/${turn.id}/verify`,{claimIds:[turn.claims[0].id],mode:'text',model:'glm-5.3'}));
  assert.equal(reverified.verifications.length,2);assert.equal(reverified.verifications[1].version,2);assert.equal(reverified.verifications[1].previousId,verification.verifications[0].id);assert.equal(reverified.verifications[1].verificationProtocol,2);
  assert.equal(reverified.verifications[1].claimText,turn.claims[0].text);
  assert.equal((await request(`/api/conversations/${turn.conversationId}/turns`)).turns.at(-1).id,next.id);
  const note=await request('/api/notes',{documentId:doc.id,text:verification.verifications[0].text,title:'核验笔记'});assert.ok((await request('/api/library/search?q='+encodeURIComponent('核验'))).results.some(r=>r.id===note.id));
  const slow=await request('/api/runs',{documentId:doc.id,question:'disconnect test',models:['slow'],analyze:false,options:{visualMode:'off'}});
  const response=await fetch(origin+`/api/runs/${slow.id}/events`), reader=response.body.getReader();await reader.read();await reader.cancel();
  const count=gateway.calls.length;const completed=await finish(slow);assert.equal(completed.answers[0].status,'done');assert.equal(gateway.calls.length,count);
  const layout=await request(`/api/documents/${doc.id}/pages/1/layout`);assert.ok(layout.paragraphs[0].located);assert.ok(layout.paragraphs[0].boxes[0].width>0);
});

test('history compaction preserves last three model-specific rounds and is cached',async t=>{
  const gateway=await fakeGateway(t), {app}=await application(t,gateway);
  const doc=app.library.addDocument(textDocument('memory.txt','A paper about history memory and citations.'));
  const turn=app.workspace.createTurn({documentId:doc.id,question:'follow',models:['k3'],analyze:false});
  turn.history=Array.from({length:7},(_,i)=>{
    const generation={id:'g'+i,documentId:doc.id,model:'k3',kind:'answer',text:(i<4?'old ':'recent ')+'x'.repeat(i<4?16000:100)};app.library.put('generation',generation);
    return {turnId:'t'+i,question:'question '+i,answers:[{model:'k3',id:generation.id}]};
  });
  const context={turn,config:gateway.config,controller:new AbortController(),task:{id:'unit',seq:0}};
  const messages=await app.workspace.historyMessages(context,'k3');clearTimeout(context.timer);
  assert.equal(messages.length,7);assert.ok(messages[1].content.includes('question 4'));assert.equal(turn.memories.k3.turns.length,4);
  assert.equal(turn.memories.k3.callCount,2);assert.ok(gateway.calls.every(c=>c.messages[1].content.length<60000));
  await app.workspace.historyMessages(context,'k3');clearTimeout(context.timer);assert.equal(gateway.calls.length,2);
});

test('PDF highlights retain paragraph anchors and ambiguous/scanned text falls back safely',async()=>{
  const doc=await extractDocument('fixture.pdf',await readFile(new URL('./assets/visual-fixture.pdf',import.meta.url)));
  const layout=await pageLayout(doc,1);assert.ok(layout.paragraphs.some(p=>p.located));
  for(const p of layout.paragraphs)for(const box of p.boxes)assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=1.001&&box.y+box.height<=1.001);
  const changed={...doc,pages:['This paragraph does not exist on the PDF page.']};assert.equal((await pageLayout(changed,1)).paragraphs[0].located,false);
  const scanned={...doc,pages:['']};assert.equal((await pageLayout(scanned,1)).paragraphs.length,0);
  const refs=resolveReferences(doc,['P1.1','P900','S1.1']);assert.deepEqual(refs.map(r=>r.valid),[true,false,false]);
  assert.equal(parseAnalysis('```claims\ninvalid\n```\nAnalysis').claims,null);
});

test('cancel preserves partial text, a new model has no borrowed answers, and branching leaves later turns intact',async t=>{
  const gateway=await fakeGateway(t), service=await application(t,gateway), {request,upload,finish,origin}=service, doc=await upload();
  const root=await finish(await request('/api/runs',{documentId:doc.id,question:'root',models:['k3'],analyze:false}));
  const second=await finish(await request('/api/runs',{documentId:doc.id,conversationId:root.conversationId,parentTurnId:root.id,question:'second',models:['glm-5.3'],analyze:false}));
  assert.ok(!JSON.stringify(gateway.calls.at(-1).messages).includes('SECRET_k3'));
  const branch=await finish(await request('/api/runs',{documentId:doc.id,conversationId:root.conversationId,parentTurnId:root.id,question:'branch',models:['k3'],analyze:false}));
  assert.equal(branch.parentTurnId,root.id);assert.equal((await request(`/api/turns/${second.id}`)).question,'second');
  const task=await request('/api/runs',{documentId:doc.id,question:'stop',models:['slow'],analyze:false});
  const stream=await fetch(origin+`/api/runs/${task.id}/events`), reader=stream.body.getReader();
  let data='';while(!data.includes('slow ')) { const chunk=await reader.read(); if(chunk.done)break; data+=new TextDecoder().decode(chunk.value); }
  await request(`/api/runs/${task.id}/cancel`,{});await reader.cancel();
  const stopped=await finish(task);assert.equal(stopped.status,'cancelled');assert.equal(stopped.answers[0].status,'cancelled');assert.ok(stopped.answers[0].text);assert.equal(stopped.answers[0].segments.length,1);
});

test('legacy import is idempotent and uploading the original file reconnects old questions and references',async t=>{
  const gateway=await fakeGateway(t), {app,request,upload}=await application(t,gateway);
  const original=await extractDocument('old.pdf',samplePdf(['Synthetic paper for testing references.']));
  const old={id:crypto.randomUUID(),question:'旧问题',document:{id:original.id,name:original.name,fingerprint:documentFingerprint(original)},answers:[{model:'k3',text:'保存的证据 [P1.1]',status:'done'}],analysis:{status:'off',text:''},status:'done',startedAt:new Date().toISOString()};
  assert.equal((await request('/api/library/import',{runs:[old]})).imported,1);
  assert.equal((await request('/api/library/import',{runs:[old]})).imported,0);
  const doc=await upload(), restored=await request(`/api/turns/${old.id}`);assert.equal(restored.document.id,doc.id);
  assert.equal((await request('/api/conversations?documentId='+doc.id)).conversations.length,1);
  assert.ok((await request('/api/library/search?q='+encodeURIComponent('旧问题'))).results.every(r=>r.documentId===doc.id));
  app.library.deleteDocument(doc.id);assert.equal(app.library.get('turn',old.id),null);
});

test('durable page transcripts are reused after cache cleanup and permit original-image verification',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'paper-reading-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const gateway=await fakeGateway(t), {app,request,upload,finish}=await application(t,gateway,directory), doc=await upload();
  const input={documentId:doc.id,question:'vision',models:['k3','glm-5.3'],options:{visualMode:'shared',visionReader:'k3',visualSelection:'all'}};
  const first=await finish(await request('/api/runs',input));assert.equal(app.library.list('transcript-page',doc.id).length,1);
  await request('/api/library/clear-cache',{});
  const second=await finish(await request('/api/runs',input));assert.ok(second.visual.cachedPages.includes(1));
  assert.equal(gateway.calls.filter(c=>c.messages[0].content.includes('视觉转录助手')).length,1);
  const verified=await finish(await request(`/api/turns/${first.id}/verify`,{claimIds:[first.claims[0].id],mode:'image',model:'k3'}));
  assert.equal(verified.verifications[0].verdict,'支持');assert.equal(verified.verifications[0].sameReader,true);
  assert.ok(gateway.calls.at(-1).messages[1].content.some(c=>c.type==='image_url'));
  const note=await request('/api/notes',{documentId:doc.id,text:verified.verifications[0].text,title:'重启恢复核验笔记'});
  app.server.closeAllConnections();app.server.close();app.library.close();
  const recovered=await application(t,gateway,directory), saved=await recovered.request(`/api/turns/${first.id}`);
  assert.equal(saved.verifications[0].verdict,'支持');assert.equal(saved.claims[0].id,first.claims[0].id);
  assert.equal((await recovered.request('/api/notes?documentId='+doc.id)).notes[0].id,note.id);
  assert.equal((await recovered.upload()).id,doc.id);assert.equal(recovered.app.library.list('transcript-page',doc.id).length,1);
});

test('a killed service restores saved generation drafts without repeating calls and can continue explicitly',async t=>{
  const gateway=await fakeGateway(t), directory=await mkdtemp(join(tmpdir(),'paper-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const worker=spawn(process.execPath,['--input-type=module','-e',`import {createApplication} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)};const app=createApplication({pdfParser:'poppler',baseUrl:process.env.TEST_GATEWAY,apiKey:'mock-secret-only',dataDirectory:process.env.TEST_LIBRARY,cacheDirectory:null});app.server.listen(0,'127.0.0.1',()=>process.send({port:app.server.address().port}));`],{env:{...process.env,TEST_GATEWAY:gateway.config.baseUrl,TEST_LIBRARY:directory},stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>worker.kill('SIGKILL'));
  const [{port}]=await once(worker,'message'), origin=`http://127.0.0.1:${port}`, config=await(await fetch(origin+'/api/config')).json(), headers={'Content-Type':'application/json','X-CSRF-Token':config.csrfToken};
  const doc=await(await fetch(origin+'/api/documents',{method:'POST',headers:{'X-CSRF-Token':config.csrfToken,'X-File-Name':'restart.pdf'},body:samplePdf()})).json();
  const task=await(await fetch(origin+'/api/runs',{method:'POST',headers,body:JSON.stringify({documentId:doc.id,question:'restart test',models:['slow'],analyze:false})})).json();
  const reader=(await fetch(origin+`/api/runs/${task.id}/events`)).body.getReader();let data='';
  while(!data.includes('slow ')){const chunk=await reader.read();if(chunk.done)break;data+=new TextDecoder().decode(chunk.value);}
  const exited=once(worker,'exit');worker.kill('SIGKILL');await exited;await reader.cancel().catch(()=>{});
  const count=gateway.calls.length, restored=await application(t,gateway,directory), snapshot=await restored.request(`/api/runs/${task.id}`);
  assert.equal(snapshot.task.status,'interrupted');assert.equal(snapshot.turn.answers[0].status,'interrupted');assert.equal(gateway.calls.length,count);
  assert.ok(snapshot.turn.answers[0].text);const continued=await restored.finish(await restored.request(`/api/generations/${snapshot.turn.answers[0].id}/continue`,{}));assert.equal(continued.answers[0].id,snapshot.turn.answers[0].id);assert.equal(continued.answers[0].segments.length,2);
});

test('two-column and mixed-size PDF highlights use separate reliable line boxes; rotated pages never expose out-of-bounds boxes',async()=>{
  const bytes=layoutPdf([
    {lines:[{x:45,y:740,text:'Left column unique evidence.'},{x:330,y:740,text:'Right column different evidence.'},{x:45,y:715,text:'Left second line for testing.'},{x:330,y:715,text:'Right second line for testing.'}]},
    {width:400,height:500,lines:[{x:40,y:440,text:'A smaller page with unique words.'}]},
    {width:612,height:792,rotate:90,lines:[{x:45,y:740,text:'A rotated page with unique words.'}]}
  ]), doc=await extractDocument('layout.pdf',bytes);
  const normal=await pageLayout(doc,1);assert.ok(normal.paragraphs.some(p=>p.located));for(const p of normal.paragraphs)for(const b of p.boxes)assert.ok(b.width<.5,'a single box must not cover both columns');
  const small=await pageLayout(doc,2);assert.equal(small.width,400);assert.equal(small.height,500);assert.ok(small.paragraphs[0].located);
  const rotated=await pageLayout(doc,3);assert.equal(rotated.width,792);assert.equal(rotated.height,612);assert.ok(rotated.paragraphs[0].located);for(const p of rotated.paragraphs)for(const b of p.boxes)assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=1.001&&b.y+b.height<=1.001);
});

test('claims stream one complete JSON object at a time, including escaped quotes and braces',()=>{
  const first={text:'A "quoted" {claim}',refs:['P6.4'],positions:[]};
  const partial=parseAnalysis('```claims\n['+JSON.stringify(first)+', {"text":"unfinished');
  assert.equal(partial.claims.length,1);assert.equal(partial.claims[0].text,first.text);assert.equal(partial.pending,true);assert.equal(partial.text,'');
});

test('reasoning exhaustion preserves tiny output and stops automatic quota spending',async t=>{
  let calls=0;const server=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'我的'},finish_reason:'length'}],usage:{completion_tokens:4000,completion_tokens_details:{reasoning_tokens:3998}}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const output={model:'reasoning',text:'',segments:[]};await generate({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fake'},output,[{role:'user',content:'test'}],{maxTokens:4000});
  assert.equal(calls,1);assert.equal(output.text,'我的');assert.equal(output.stopReason,'reasoning_budget');assert.equal(output.status,'incomplete');assert.match(output.error,/12000/);
});

test('SSE heartbeats are removed on response finish even when a keep-alive socket is still open',async t=>{
  const gateway=await fakeGateway(t),{app}=await application(t,gateway);const doc=app.library.addDocument(textDocument('event.txt','Reliable source text for lifecycle testing.'));
  const turn=app.workspace.createTurn({documentId:doc.id,question:'test',models:['k3']});const task={id:'timer-test',seq:1,turnId:turn.id};app.workspace.active.set(task.id,{task,turn});
  const {EventEmitter}=await import('node:events');const response=new EventEmitter();let writes=0;Object.assign(response,{writeHead(){},flushHeaders(){},write(){assert.ok(!this.writableEnded);writes++;},writableEnded:false,destroyed:false});
  t.mock.timers.enable({apis:['setInterval']});app.workspace.subscribe(task.id,response);response.writableEnded=true;response.emit('finish');t.mock.timers.tick(30001);assert.equal(writes,1);assert.equal(app.workspace.listeners.get(task.id).size,0);app.workspace.active.delete(task.id);
});

test('an invalid math-font XML glyph does not discard readable paragraphs on the same PDF page',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'paper-bbox-control-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'pdftotext-fixture.py');await writeFile(path,`#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write(b'<html xmlns="http://www.w3.org/1999/xhtml"><body><page width="612" height="792"><flow><block><line><word xMin="10" yMin="10" xMax="20" yMax="20">\\x12</word></line><line><word xMin="40" yMin="60" xMax="400" yMax="75">Readable paragraph remains available for highlighting.</word></line></block></flow></page></body></html>')\n`);await chmod(path,0o700);
 const previous=process.env.PDFTOTEXT_PATH;process.env.PDFTOTEXT_PATH=path;t.after(()=>{if(previous===undefined)delete process.env.PDFTOTEXT_PATH;else process.env.PDFTOTEXT_PATH=previous;});
 const layout=await pageLayout({pages:['Readable paragraph remains available for highlighting.'],sourceType:'page',pdfBuffer:samplePdf()},1);
 assert.equal(layout.paragraphs[0].located,true);assert.equal(layout.paragraphs[0].boxes.length,1);
});
