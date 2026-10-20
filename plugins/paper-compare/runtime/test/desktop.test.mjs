import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

async function setup(t) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'), {url:'http://localhost:3210',runScripts:'outside-only'}), w = dom.window;
  t.after(() => dom.window.close());
  const evaluate = source => vm.runInContext(source, dom.getInternalVMContext());
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.matchMedia = () => ({matches:false});
  w.HTMLDialogElement.prototype.showModal = function() {this.open=true;};
  w.HTMLDialogElement.prototype.close = function() {if(this.open) {this.open=false;this.dispatchEvent(new w.Event('close'));}};
  for (const name of ['workspace','desktop','evidence','app']) evaluate((await readFile(new URL(`../public/${name}.js`,import.meta.url),'utf8')).replace(/init\(\);\s*$/,''));
  const doc = {id:'doc',name:'paper.pdf',pages:7,chars:2000,format:'pdf'}, g = (model,id) => ({id,model,text:'Sample answer [P1.1]',status:'done',version:1,segments:[]});
  const turn = {id:'turn',conversationId:'conversation',document:doc,question:'原始问题',models:['k3','glm-5.3'],reviewer:'glm-5.3',status:'done',startedAt:new Date().toISOString(),answers:[g('k3','a'),g('glm-5.3','b')],analysis:{id:'analysis',model:'glm-5.3',status:'off',text:'',segments:[]},claims:[],verifications:[]};
  w.fixture = {doc,turn};
  evaluate(`Object.assign(state,{documents:[fixture.doc],activeDocumentId:'doc',selected:new Set(['k3','glm-5.3']),models:['k3','glm-5.3'],config:{workspace:true,keyConfigured:true},restoringCache:false});renderMarkdown=text=>escapeHtml(text);api=async path=>path==='/api/library'?{documents:[fixture.doc],stats:{documents:1,turns:1,bytes:2000}}:path.startsWith('/api/conversations/conversation')?{turns:[fixture.turn]}:path.startsWith('/api/conversations')?{conversations:[{id:'conversation',title:'现有对话'}]}:path.startsWith('/api/runs')?{tasks:[]}:{};`);
  evaluate(`bindEvents(); openSource=async()=>{state.sourceDocument={id:'doc',format:'txt',visualAvailable:false};$('sourceDialog').showModal();};renderSourcePage=()=>{};`);
  await w.PaperWorkspace.init();
  return {w,doc,turn,evaluate,$:id=>w.document.getElementById(id)};
}

test('a temporary gateway outage retains the last selected models and reviewer after refresh', async t => {
  const {evaluate,$} = await setup(t);
  evaluate(`state.models=['k3','mimo-v2.6-pro'];state.selected=new Set(state.models);renderModels();$('reviewerSelect').value='k3';saveDraft();
    state.models=[];state.selected=new Set();$('reviewerSelect').innerHTML='';
    api=async path=>{if(path.startsWith('/api/models'))throw new Error('HTTP 502: upstream temporarily unavailable');if(path==='/api/config')return{workspace:true,keyConfigured:true};if(path==='/api/documents')return{documents:[fixture.doc]};if(path==='/api/vision')return{models:[]};return {};};`);
  await evaluate('init()');
  assert.equal(evaluate('JSON.stringify([...state.selected])'),JSON.stringify(['k3','mimo-v2.6-pro']));
  assert.equal($('reviewerSelect').value,'k3');assert.equal($('modelList').querySelectorAll('input:checked').length,2);
  assert.match($('connectionStatus').textContent,/接口连接失败/);
});

test('ForX managed settings open the host instead of a duplicate credential form', async t => {
  const {w,evaluate,$} = await setup(t), messages = [];
  Object.defineProperty(w, 'parent', {value: {postMessage: message => messages.push(message)}});
  evaluate(`state.config.managedConnection=true;api=async path=>path==='/api/config'?{managedConnection:true,keyConfigured:true,connection:{account:'researcher'}}:{models:['k3','glm-5.3']};`);
  await evaluate('loadModels(true)');
  $('settingsBtn').click();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'paper-compare:open-provider-settings');
  assert.ok(!$('settingsDialog').open);
  assert.equal($('settingsBtn').getAttribute('aria-label'), 'ForX 账号与模型');
  assert.match($('connectionStatus').textContent, /ForX 已连接/);
  evaluate('state.config.managedConnection=false');
  $('settingsBtn').click();
  assert.ok($('settingsDialog').open);
});

test('desktop flow keeps follow-up targets explicit, tabs stable and new conversations empty',async t => {
  const {w,turn,evaluate,$} = await setup(t);
  w.PaperWorkspace.context().turns.push({...turn,id:'unrelated',conversationId:'other',question:'其他对话内容'});
  w.PaperDesktop.render(turn);
  assert.ok(!$('turnTrail').textContent.includes('其他对话内容'));
  assert.ok($('questionForm').classList.contains('composer-closed'));
  assert.equal(w.document.querySelector('#activeQuestion strong').textContent,'原始问题');
  turn.answers[1].status='incomplete';w.PaperDesktop.render(turn);
  assert.match($('workbenchProgress').textContent,/1 份内容待处理/);turn.answers[1].status='done';
  evaluate(`openReader('answer',0,true);$('answerDialogContent').scrollTop=123;`);
  await evaluate('openSource(1)');
  assert.ok(!$('answerDialog').open);assert.equal(evaluate('state.reader'),null);
  // The sidebar toggle must still work while the nonmodal source view is open.
  evaluate('setSidebar(true);');assert.ok($('paperSidebar').hidden);assert.ok($('sourceDialog').open);
  evaluate('setSidebar(false);');assert.ok(!$('paperSidebar').hidden);assert.ok($('sourceDialog').open);
  assert.ok(w.document.body.classList.contains('three-pane'));
  $('sourceDialog').close();
  assert.ok($('answerDialog').open);assert.ok($('answerDialog').classList.contains('reader-fullscreen'));
  assert.equal(evaluate('state.reader.index'),0);assert.equal($('answerDialogContent').scrollTop,123);
  $('answerDialog').close();
  // Adding an image from a citation should lead to the composer, instead of reopening the modal reader.
  evaluate(`openReader('answer',0,true);`);await evaluate('openSource(1)');
  evaluate(`state.sourceDocument.visualAvailable=true;$('sourcePageSelect').innerHTML='<option value=1>1</option>';`);
  $('sourceUsePageBtn').click();
  assert.ok(!$('answerDialog').open);assert.ok(!$('sourceDialog').open);assert.ok(!$('questionForm').classList.contains('composer-closed'));
  assert.equal($('visualSelection').value,'manual');assert.equal($('visualPages').value,'1');
  w.document.querySelector('[data-ws="follow-model"]').click();await new Promise(r=>setTimeout(r,0));
  assert.equal(w.PaperWorkspace.context().onlyModel,'k3');assert.equal($('askBtn').textContent,'向 k3 追问');
  assert.ok(!$('questionForm').classList.contains('composer-closed'));
  w.document.querySelector('[data-ws="follow-all"]').click();await new Promise(r=>setTimeout(r,0));
  assert.equal(w.PaperWorkspace.context().onlyModel,null);assert.equal($('askBtn').textContent,'向 2 个模型追问');
  $('tab-evidence').click();assert.equal($('resultsSection').dataset.workbenchView,'evidence');assert.ok($('verifySelected').disabled);
  $('newConversation').click();
  assert.equal(evaluate('state.run'),null);assert.ok($('resultsSection').hidden);assert.equal(w.PaperWorkspace.context().parent,null);
  assert.ok(!$('questionForm').classList.contains('composer-closed'));assert.equal($('askBtn').textContent,'开始并行提问');
  assert.ok(!$('exportBtn').disabled);$('exportBtn').click();assert.equal($('exportScope').value,'notes');assert.ok($('exportScope').querySelector('[value=turn]').disabled);
});

test('answer menus preserve advanced actions, dismiss with focus, and show recovery only when needed',async t => {
  const {w,turn,$} = await setup(t), card = w.document.querySelector('.answer-card'), tools = card.querySelector('.answer-tools');
  assert.ok(tools.querySelector('[data-ws="continue"]').closest('details'));
  const menu = tools.querySelector('details'), trigger = menu.querySelector('summary');
  trigger.click(); await new Promise(r=>setTimeout(r,0)); assert.ok(menu.open);
  trigger.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.equal(w.document.activeElement.getAttribute('data-copy-answer'),'0');
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.ok(!menu.open);assert.equal(w.document.activeElement,trigger);
  turn.answers[0].status='incomplete';w.PaperWorkspace.render(turn);
  assert.equal(tools.querySelector('[data-ws="continue"]').closest('details'),null);
  assert.ok(!card.querySelector('.generation-recovery').hidden);
  turn.answers[0].status='cancelled';turn.answers[0].error='This operation was aborted';w.PaperWorkspace.render(turn);
  assert.match(card.querySelector('.generation-recovery').textContent,/已停止生成/);assert.ok(!card.querySelector('.generation-recovery').textContent.includes('aborted'));
  turn.answers[0].text='';w.PaperWorkspace.render(turn);assert.equal(tools.querySelectorAll('[data-ws="retry"]').length,1);assert.ok(!tools.querySelector('[data-ws="continue"]'));
  turn.answers[0].status='done';turn.answers[0].text='Saved answer';turn.answers[0].error=null;w.PaperWorkspace.render(turn);
  assert.ok(card.querySelector('.generation-recovery').hidden);
  assert.ok(tools.querySelector('[data-ws="versions"]'));
  assert.ok(tools.querySelector('[data-ws="provenance"]'));
  assert.ok(!$('historyBtn'));
  $('sourceDialog').showModal();
  const sourceMenu = w.document.querySelector('.source-menu');sourceMenu.open=true;const field = $('sourcePanelWidth');field.focus();
  const nativeKey = new w.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true});field.dispatchEvent(nativeKey);
  assert.equal(nativeKey.defaultPrevented,false);assert.equal(w.document.activeElement,field);
});

test('starting a generation locks repeat actions before the request completes and releases on failure',async t => {
  const {w,evaluate,$} = await setup(t);let calls=0,reject;
  w.rejectRequest = () => reject(new Error('test gateway failed'));
  w.apiRequest = () => {calls++;return new Promise((_,r)=>reject=r);};
  evaluate('api=apiRequest;');
  const retry = w.document.querySelector('[data-ws="retry"]'); retry.click(); retry.click();
  assert.equal(calls,1);assert.ok(evaluate('state.busy'));assert.ok($('workspaceStop').disabled === false);
  w.rejectRequest();await new Promise(r=>setTimeout(r,0));
  assert.equal(evaluate('state.busy'),false);assert.match($('toast').textContent,/test gateway failed/);
});
test('local source reading uses one contextual action and does not change the Q&A branch or model selection',async t=>{
  const {w,evaluate,$}=await setup(t);
  evaluate(`state.sourceDocument={id:'doc',extractionVersion:2,visualAvailable:true,format:'pdf',sourceType:'page'};state.sourceParagraph=6;$('sourcePageSelect').innerHTML='<option value=6 selected>第6页</option>';state.vision={checkedAt:new Date().toISOString(),models:[{model:'k3',status:'supported'}]};`);
  const object={id:'evidence',ref:'P6.6',documentId:'doc',extractionVersion:2,page:6,paragraph:6,type:'equation',label:'公式 6',region:{x:.1,y:.2,width:.5,height:.1}};
  w.mockObject=object;
  evaluate(`api=async path=>path.includes('/objects')?{objects:[mockObject]}:path.includes('/readings')?{readings:[],tasks:[]}:{};`);
  w.PaperEvidence.refreshModels(); await w.PaperEvidence.sourceChanged();
  assert.ok($('sourceCropBtn').hidden===false);assert.equal($('sourceObjectSelect').value,'P6.6');assert.ok(!$('sourceReadBtn').disabled);assert.equal($('sourceReadBtn').textContent,'精读此处');
  const parent=w.PaperWorkspace.context().parent, models=evaluate('JSON.stringify([...state.selected])');let count=0,reject;
  w.localRequest=()=>{count++;return new Promise((_,r)=>reject=r);};evaluate('api=localRequest;');$('sourceReadBtn').click();$('sourceReadBtn').click();assert.equal(count,1);assert.equal(w.PaperWorkspace.context().parent,parent);assert.equal(evaluate('JSON.stringify([...state.selected])'),models);assert.equal(evaluate('state.busy'),false);
  reject(new Error('local reader failed'));await new Promise(r=>setTimeout(r,0));assert.ok(!$('sourceReadBtn').disabled);assert.match($('toast').textContent,/local reader failed/);
  assert.ok([...$('verifyMode').options].some(o=>o.value==='investigate'));assert.ok(w.document.querySelector('#sourceMenuItems #sourceReadingHistory'));
});
test('closing the source panel restores the originating evidence view even after opening another reading',async t=>{
  const {evaluate,$}=await setup(t);
  $('workspaceDialogTitle').textContent='证据记录';$('workspaceDialogBody').innerHTML='<p>Original source evidence</p>';$('workspaceDialog').showModal();$('workspaceDialogBody').scrollTop=76;
  await evaluate('openSource(1)');assert.equal($('workspaceDialog').open,false);
  $('workspaceDialogTitle').textContent='临时精读';$('workspaceDialogBody').innerHTML='<p>Different reading</p>';
  $('sourceDialog').close();assert.ok($('workspaceDialog').open);assert.equal($('workspaceDialogTitle').textContent,'证据记录');assert.match($('workspaceDialogBody').innerHTML,/Original source evidence/);assert.equal($('workspaceDialogBody').scrollTop,76);
});
