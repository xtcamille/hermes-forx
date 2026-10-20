'use strict';
window.PaperWorkspace = (() => {
  const ws = { ready: false, doc: null, conversation: null, parent: null, selection: '', onlyModel: null, stream: null, taskId: null, seq: -1, turns: [], notes: [], layoutRequest: 0, documentRequest: 0, selectionText: '' };
  const esc = value => escapeHtml(value);
  const button = (label, action, value = '') => `<button type="button" class="button button-quiet button-small" data-ws="${action}" data-value="${esc(value)}">${label}</button>`;
  const invoke = async fn => { try { return await fn(); } catch (error) { toast(error.message); } };
  const statusName = status => ({ waiting: '等待', running: '生成中', continuing: '正在续写', done: '完成', incomplete: '待继续', interrupted: '已中断', cancelled: '已停止', error: '失败', skipped: '未运行', off: '未启用' }[status] || status);
  function inject() {
    $('documentList').insertAdjacentHTML('beforebegin', '<div class="library-tools"><input id="librarySearch" type="search" placeholder="搜索论文、问答和笔记" aria-label="搜索论文库"><button id="librarySearchBtn" type="button">搜索</button></div><p id="libraryStats" class="muted"></p>');
    $('questionForm').insertAdjacentHTML('beforebegin', '<section class="conversation-bar"><label>对话 <select id="conversationSelect" aria-label="选择对话"></select></label><button id="newConversation" class="button button-quiet" type="button">新对话</button><button id="turnHistory" class="button button-quiet" type="button">对话记录</button><button id="notesBtn" class="button button-quiet" type="button">阅读笔记</button><label>阅读状态 <select id="readingStatus"><option value="unread">未读</option><option value="reading">阅读中</option><option value="review">待核验</option><option value="done">已读</option></select></label></section>');
    $('question').insertAdjacentHTML('beforebegin', '<div id="followupBanner" class="followup-banner" hidden></div>');
    $('questionForm').insertAdjacentHTML('beforeend', '<p id="memoryNotice" class="memory-notice">截断时最多自动续写 2 次 · 较早对话按模型分别摘要 · 刷新后可恢复任务</p>');
    $('resultsSection').insertAdjacentHTML('beforeend', '<section id="evidencePanel" class="evidence-panel" hidden><header><div><h2>逐项核验</h2><p>引用有效性由程序检查，结论判定由模型给出。</p></div><div class="evidence-actions"><select id="verifyModel" aria-label="核验模型"></select><select id="verifyMode" aria-label="核验方式"><option value="text">文字证据</option><option value="image">原图与局部</option><option value="investigate">按缺口补查</option></select><button id="verifySelected" class="button button-outlined" type="button">核验选中</button><button id="rebuildClaims" class="button button-quiet" type="button">重新整理结论</button></div></header><div id="claimList"></div><div id="verificationList"></div></section>');
    $('analysisPanel').querySelector('.analysis-tools').insertAdjacentHTML('afterbegin', '<button id="continueAnalysis" class="button button-quiet button-small" type="button">继续生成</button><button id="analysisVersions" class="button button-quiet button-small" type="button">版本</button>');
    $('analysisContent').insertAdjacentHTML('beforebegin', '<p id="analysisRecovery" class="context-notice partial" hidden></p>');
    $('sourceImage').outerHTML = '<div class="pdf-page-stage"><img id="sourceImage" alt="论文原始页面"><div id="pdfHighlights" aria-label="原文引用高亮"></div></div>';
    $('sourceDialog').classList.add('source-panel');
    $('sourceDialog').querySelector('.source-controls').insertAdjacentHTML('beforeend', '<label class="source-width-control">宽度<input id="sourcePanelWidth" type="range" min="360" max="800" value="560" aria-label="原文面板宽度"></label>');
    $('sourceImageWrap').insertAdjacentHTML('beforebegin', '<p id="sourceLocationStatus" class="muted"></p>');
    $('exportDialog').querySelector('.export-choices').insertAdjacentHTML('beforebegin', '<label class="export-scope">导出范围<select id="exportScope" aria-label="导出范围"><option value="turn">当前轮</option><option value="conversation">整个对话（含分支）</option><option value="notes">本篇论文笔记</option></select></label>');
    $('exportDialog').querySelector('h2').textContent = '导出阅读记录';
    $('exportDialog').querySelector('.dialog-header p').textContent = '选择当前轮、整个对话或论文笔记。报告保留完整正文、调用记录和核验来源。';
    document.body.insertAdjacentHTML('beforeend', '<dialog id="workspaceDialog" class="dialog workspace-dialog"><div class="dialog-header"><h2 id="workspaceDialogTitle"></h2><button class="icon-button" data-close="workspaceDialog" aria-label="关闭">×</button></div><div id="workspaceDialogBody"></div></dialog><div id="selectionTools" class="selection-tools" hidden><span>已选中内容</span>'+button('追问', 'selection-follow')+button('加入笔记', 'selection-note')+button('建立核验卡片', 'selection-claim')+'<button data-ws="selection-dismiss" type="button" aria-label="关闭选中文字操作">×</button></div>');
    $('paperSidebar').querySelector('.sidebar-note p').textContent = '论文和阅读记录自动保存到本机。密钥仅保存在服务端内存；提问时按所选模式发送资料。';
    $('sourceImage').addEventListener('load', () => { $('sourceImageStatus').hidden = true; $('sourceImage').hidden = false; scrollHighlight(); });
    $('sourceImage').addEventListener('error', () => { $('sourceImageStatus').textContent = '页面图片无法读取，请检查原文件。'; $('sourceImageStatus').hidden = false; });
  }
  function dialog(title, html) { $('workspaceDialogTitle').textContent = title; $('workspaceDialogBody').innerHTML = html; if (!$('workspaceDialog').open) $('workspaceDialog').showModal(); }
  function returnToReader() {
    const back = ws.sourceReturn; ws.sourceReturn = null;
    const origin = back && $(back.id); if (!origin || origin.open) return;
    if (back.id === 'answerDialog') {
      state.reader = back.reader;
      origin.classList.toggle('reader-fullscreen', back.fullscreen);
      $('readerSizeBtn').textContent = back.fullscreen ? '退出全屏' : '全屏阅读';
    }
    if (back.id === 'workspaceDialog' && back.html !== undefined) { $('workspaceDialogTitle').textContent = back.title; $('workspaceDialogBody').innerHTML = back.html; }
    origin.showModal();
    const content = origin.querySelector('.expanded-answer,#workspaceDialogBody'); if (content) content.scrollTop = back.scroll;
  }
  function banner() {
    const oldVersion = state.run && (state.run.document.extractionVersion || 1) < (activeDocument()?.extractionVersion || 1);
    $('followupBanner').hidden = !ws.parent && !ws.selection && !oldVersion;
    $('followupBanner').innerHTML = `<div class="followup-target"><span>${ws.parent ? `追问第 ${Math.max(1, ws.turns.findIndex(t => t.id === ws.parent) + 1)} 轮 · ${ws.onlyModel ? `仅 ${esc(ws.onlyModel)}` : `${state.selected.size} 个模型分别沿自己的历史回答`}` : '独立问题'}</span>${ws.onlyModel ? button('改为多模型', 'follow-all') : ''}</div>${ws.selection ? `<div class="selection-attachment"><span>引用材料</span><blockquote>${esc(ws.selection.slice(0, 240))}${ws.selection.length > 240 ? '…' : ''}</blockquote><button class="icon-button" data-ws="clear-selection" type="button" aria-label="移除引用材料">${icon('close')}</button></div>` : ''}`;
    if (oldVersion) $('followupBanner').insertAdjacentHTML('beforeend', `<p class="muted">此对话沿用原文 v${state.run.document.extractionVersion || 1}，引用与追问保持原版本。新建独立对话使用最新的 MinerU 原文。</p>`);
    window.PaperDesktop?.render();
  }
  async function library() {
    const data = await api('/api/library'); state.documents = data.documents; renderDocuments();
    $('libraryStats').textContent = `${data.stats.documents} 篇 · ${data.stats.turns} 轮阅读 · ${(data.stats.bytes / 1048576).toFixed(1)} MB`;
    if (activeDocument()) $('readingStatus').value = activeDocument().readingStatus || 'unread';
    $('historyCount').textContent = data.stats.turns;
  }
  async function documentChanged(force = false) {
    const doc = state.activeDocumentId; if (!force && doc === ws.doc) return;
    const request = ++ws.documentRequest;
    ws.doc = doc; ws.conversation = null; ws.parent = null; ws.selection = ''; ws.onlyModel = null; ws.turns = []; banner();
    $('question').placeholder = '为这篇论文提出一个新问题';
    ws.stream?.close(); state.busy = false; ws.taskId = null; state.run = null; $('resultsSection').hidden = true; $('emptyState').hidden = false;
    const list = await api('/api/conversations' + (doc ? `?documentId=${encodeURIComponent(doc)}` : ''));
    if (request !== ws.documentRequest) return;
    const conversations = doc ? list.conversations : [];
    $('conversationSelect').innerHTML = '<option value="">新对话</option>' + conversations.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    if (conversations.length) { ws.conversation = conversations[0].id; $('conversationSelect').value = ws.conversation; await loadConversation(); }
    if (request !== ws.documentRequest) return;
    if (doc) {
      const tasks = await api(`/api/runs?documentId=${doc}`), active = tasks.tasks.find(t => t.status === 'running');
      if (request !== ws.documentRequest) return;
      if (active) await watch(active.id);
      $('readingStatus').value = activeDocument()?.readingStatus || 'unread';
    }
    updateControls();
    if ($('sourceDialog').open && state.sourceDocument?.id !== doc) { if (doc) await openSource(); else $('sourceDialog').close(); }
  }
  async function loadConversation() {
    if (!ws.conversation) { ws.parent = null; banner(); return; }
    const conversation = ws.conversation, data = await api(`/api/conversations/${conversation}/turns`);
    if (conversation !== ws.conversation) return;
    ws.turns = data.turns;
    if (data.turns.length) showTurn(data.turns.at(-1));
  }
  function showTurn(turn) {
    const different = state.run?.id !== turn.id || state.run?.answers.map(a => a.id).join() !== turn.answers.map(a => a.id).join();
    if (ws.conversation !== turn.conversationId) ws.turns = [];
    state.run = turn; ws.conversation = turn.conversationId; ws.parent = turn.id; ws.onlyModel = null;
    if ([...$('conversationSelect').options].some(o => o.value === ws.conversation)) $('conversationSelect').value = ws.conversation;
    if (!ws.turns.some(t => t.id === turn.id)) ws.turns.push(turn);
    if (different) renderRun(); else renderRunContent();
    $('question').placeholder = '继续追问这篇论文，例如：请详细展开刚才提到的假设。'; banner(); updateControls();
  }
  async function watch(taskId) {
    ws.stream?.close(); ws.taskId = taskId; ws.seq = -1; state.busy = true; updateControls();
    const source = new EventSource(paperUrl(`/api/runs/${taskId}/events`)); ws.stream = source;
    source.addEventListener('snapshot', event => {
      if (ws.taskId !== taskId) return;
      const payload = JSON.parse(event.data); if (payload.task.seq <= ws.seq) return; ws.seq = payload.task.seq;
      state.busy = !payload.terminal; showTurn(payload.turn);
      if (payload.terminal) {
        source.close(); ws.stream = null; state.busy = false; updateControls();
        invoke(async () => { await library(); const data = await api('/api/conversations?documentId=' + state.activeDocumentId); $('conversationSelect').innerHTML = '<option value="">新对话</option>' + data.conversations.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join(''); $('conversationSelect').value = ws.conversation || ''; });
      }
    });
    source.onerror = () => { if (ws.stream === source) $('runStatus').textContent = '连接暂时中断，正在重新连接；任务在本地服务继续运行。'; };
  }
  function options() { return Object.fromEntries(['temperature', 'maxTokens', 'contextBudget', 'analysisMaxTokens', 'analysisContextBudget', 'maxVisualPages'].map(k => [k, Number($(k).value)]).concat(['visualMode', 'visionReader', 'visualSelection', 'visualPages'].map(k => [k, $(k).value]))); }
  async function ask(event) {
    event.preventDefault(); if (state.busy || !state.activeDocumentId) return;
    const question = $('question').value.trim(); if (!question) return $('question').focus();
    state.busy = true; updateControls();
    try {
      const task = await api('/api/runs', { method: 'POST', json: { requestId: crypto.randomUUID(), documentId: state.activeDocumentId, conversationId: ws.conversation, parentTurnId: ws.parent, question, selection: ws.selection, models: ws.onlyModel ? [ws.onlyModel] : [...state.selected], reviewer: $('reviewerSelect').value, options: options(), analyze: $('analyzeToggle').checked } });
      ws.selection = ''; $('question').value = ''; saveDraft(); await watch(task.id);
    } catch (error) { state.busy = false; updateControls(); toast(error.message); }
  }
  async function outputAction(generationId, action) {
    if (state.busy) return;
    state.busy = true; updateControls();
    try {
      const task = await api(`/api/generations/${generationId}/${action}`, { method: 'POST', json: { requestId: crypto.randomUUID(), model: $('reviewerSelect').value, options: options() } }); await watch(task.id);
    } catch (error) { state.busy = false; updateControls(); throw error; }
  }
  function render(run) {
    if (!ws.ready || !run?.conversationId) return;

    $('runStatus').textContent = run.memoryStatus || (run.status === 'running' ? `${run.answers.filter(a => a.status === 'done').length}/${run.answers.length} 个模型完成 · 回答和分析自动保存中` : `本轮${statusName(run.status)} · ${seconds(run.elapsedMs)}${run.error ? ` · ${run.error}` : ''}`);
    run.answers.forEach((answer, index) => {
      const card = $('answersGrid').querySelector(`[data-answer-index="${index}"]`); if (!card) return;
      card.querySelector('.answer-state').textContent = statusName(answer.status);
      card.querySelector('.generation-actions')?.remove();
      const controls = card.querySelector('.answer-tools');
      if (controls.parentElement !== card.querySelector('.answer-header')) card.querySelector('.answer-header').append(controls);
      const canContinue = PaperDesktop.unfinished(answer.status) && !!answer.text, needsRetry = PaperDesktop.unfinished(answer.status) && !answer.text;
      const html = `<button data-fullscreen-answer="${index}" title="全屏阅读" aria-label="全屏阅读 ${esc(answer.model)} 的回答">${icon('expand')}<span>阅读</span></button>${button('追问', 'follow-model', answer.model)}${canContinue ? button('继续生成', 'continue', answer.id) : needsRetry ? button('重新生成', 'retry', answer.id) : ''}${PaperDesktop.menu(`${answer.model} 回答更多操作`, `<button data-copy-answer="${index}" type="button">${icon('copy')}复制回答</button>${button('保存到笔记', 'note-answer', String(index))}<div class="menu-separator"></div>${!needsRetry ? button('重新生成（新版本）', 'retry', answer.id) : ''}${button(`查看版本 · ${answer.version || 1}`, 'versions', answer.id)}${button('上下文与调用记录', 'provenance', answer.id)}${!canContinue && answer.text ? button('手动追加内容', 'continue', answer.id) : ''}`)}`;
      setRenderedContent(controls, () => html, html);
      controls.querySelectorAll('button').forEach(b => { b.disabled = (state.busy && ['continue', 'retry', 'follow-model'].includes(b.dataset.ws)) || (['continue','follow-model','note-answer'].includes(b.dataset.ws) || b.hasAttribute('data-copy-answer') || b.hasAttribute('data-fullscreen-answer')) && !answer.text; if (b.dataset.ws === 'continue') b.classList.toggle('needs-action', canContinue); });
      card.querySelector('.answer-state').textContent = answer.status === 'continuing' ? `${answer.segments.at(-1)?.automatic ? '自动续写 ' + answer.segments.filter(s => s.automatic).length + '/2' : '手动继续'} · 第 ${answer.segments.length} 段` : answer.status === 'running' && answer.reasoningChars && !answer.text ? `思考中 · ${formatNumber(answer.reasoningChars)} 字符` : statusName(answer.status);
      card.querySelector('.answer-metrics').textContent = [answer.text ? `${formatNumber(answer.text.length)} 字符` : '等待正文', answer.elapsedMs ? seconds(answer.elapsedMs) : '', `${answer.callCount || answer.segments?.length || 0} 次调用`].filter(Boolean).join(' · ');
      card.querySelector('.answer-metrics').title = [metrics(answer), answer.usage?.partial ? '用量不完整' : '', answer.inputChars ? `输入约 ${formatNumber(Math.ceil(answer.inputChars / 2))} tokens（估算）` : ''].filter(Boolean).join(' · ');
      let recovery = card.querySelector('.generation-recovery');
      if (!recovery) { recovery = document.createElement('p'); recovery.className = 'generation-recovery'; card.querySelector('.answer-footer').before(recovery); }
      recovery.hidden = !answer.error && !['incomplete', 'interrupted', 'cancelled'].includes(answer.status);
      recovery.textContent = !answer.text && PaperDesktop.unfinished(answer.status) ? '尚未收到回答正文，可以重新生成；原调用记录已保存。' : answer.status === 'cancelled' ? '已停止生成，现有内容已保存。点击“继续生成”从断点接着写。' : answer.status === 'interrupted' ? '任务已中断，现有内容已保存，可以继续生成。' : answer.error || '回答尚未完整结束，现有内容已保存，可以继续生成。';
    });
    $('analysisMeta').textContent = `${run.analysis.model} · ${statusName(run.analysis.status)} · ${run.analysis.callCount || run.analysis.segments?.length || 0} 次调用${run.analysis.stale ? ' · 回答版本已变化，可重新分析' : ''}`;
    $('retryAnalysisBtn').querySelector('span').textContent = '重新分析（新版本）';
    $('retryAnalysisBtn').title = '读取已保存的回答，按当前分析参数生成新版本；旧版本保留。';
    $('continueAnalysis').disabled = state.busy || !run.analysis.id || !(run.analysis.text || run.analysis.segments?.some(s => s.text));
    $('analysisRecovery').hidden = !run.analysis.error && !['incomplete', 'interrupted', 'cancelled'].includes(run.analysis.status);
    $('analysisRecovery').textContent = run.analysis.status === 'cancelled' ? '已停止分析，现有内容已保存。' : run.analysis.status === 'interrupted' ? '分析已中断，现有内容已保存。' : run.analysis.error || '分析尚未完整结束，内容已保存，可点击“继续生成”。';
    $('analysisVersions').disabled = !run.analysis.id;
    $('analysisProvenance').dataset.value = run.analysis.id || '';
    $('analysisProvenance').disabled = !run.analysis.id;
    $('retryAnalysisBtn').disabled = state.busy || run.answers.filter(a => a.text).length < 2;
    if (run.analysis.status !== 'off' && !run.analysis.text && !pendingStatus(run.analysis.status)) $('analysisContent').innerHTML = `<p class="muted">${esc(run.analysis.status === 'cancelled' ? '分析已停止，暂无正文。可以从更多菜单重新分析。' : run.analysis.status === 'interrupted' ? '分析已中断，暂无正文。可以从更多菜单重新分析。' : run.analysis.error || run.analysis.reason || '暂无分析正文，可重试分析。')}</p>`;
    if (!run.analysis.text && pendingStatus(run.analysis.status)) $('analysisContent').innerHTML = `<div class="answer-placeholder"><span class="spinner"></span>${run.claims?.length ? `已整理 ${run.claims.length} 条结论，可先切到证据核验查看；分析正文随后显示。` : run.analysis.status === 'waiting' ? '各模型回答与自动续写结束后开始分析。' : `分析模型正在${run.analysis.reasoningChars ? '思考（' + formatNumber(run.analysis.reasoningChars) + ' 字符）' : '整理结论'}，收到正文后实时显示。`}</div>`;
    const memories = Object.values(run.memories || {});
    $('memoryNotice').innerHTML = (run.memoryStatus ? esc(run.memoryStatus) : '截断时最多自动续写 2 次 · 历史预算 60,000 字符') + memories.map(m => `<details><summary>${esc(m.model)} 已摘要 ${m.turns.length} 轮 · ${m.callCount || 1} 次调用 · ${m.usage?.total_tokens === undefined ? '用量未返回' : `${formatNumber(m.usage.total_tokens)} tokens`}</summary><p>覆盖轮次：${m.turns.map(id => button(id.slice(0, 8), 'open-turn', id)).join(' ')}</p><div class="markdown">${renderMarkdown(m.text)}</div></details>`).join('') + Object.entries(run.memoryDrafts || {}).map(([model, text]) => `<details open><summary>${esc(model)} 历史摘要${state.busy ? '生成中' : '未完成'}</summary><div class="markdown">${renderMarkdown(text)}</div></details>`).join('');
    $('evidencePanel').hidden = false;
    if (!$('verifyModel').options.length || $('verifyModel').dataset.models !== state.models.join(',') || $('verifyModel').dataset.turn !== run.id || $('verifyModel').dataset.reviewer !== run.reviewer) { $('verifyModel').innerHTML = state.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join(''); $('verifyModel').value = run.reviewer; $('verifyModel').dataset.models = state.models.join(','); $('verifyModel').dataset.turn = run.id; $('verifyModel').dataset.reviewer = run.reviewer; $('verifyMode').onchange(); }
    const selected = new Set([...$('claimList').querySelectorAll('input:checked')].map(e => e.value));
    const key = JSON.stringify(run.claims || []);
    setRenderedContent($('claimList'), () => (run.claims || []).map(c => `<article class="claim-card" data-claim-id="${esc(c.id)}"><label><input type="checkbox" aria-label="选择结论：${esc(c.text)}" value="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''}><span class="markdown claim-text">${renderMarkdown(c.text)}</span></label>${c.positions?.length ? `<details class="claim-opinions"><summary>模型观点</summary><div class="claim-positions">${c.positions.map(p => `<p><b>${esc(p.model)}</b> ${esc(p.text)}</p>`).join('')}</div></details>` : ''}<div class="claim-references">${(c.evidence || []).map(r => `<span class="${r.valid ? 'reference-valid' : 'reference-invalid'}">${renderMarkdown(`[${r.ref}]`)} ${r.valid ? '引用存在' : '引用无效'}</span>`).join('') || '<span class="muted">尚未提供引用</span>'}</div><p class="muted">${esc(c.question || '待核验结论是否得到原文支持')}</p><div class="claim-actions">${button('核验', 'verify-claim', c.id)}${PaperDesktop.menu('结论更多操作', button('追问这条结论', 'follow-claim', c.id) + button('保存到笔记', 'note-claim', c.id))}</div></article>`).join('') || `<p class="muted">${esc(run.analysis.claimsError || '对比分析会在这里整理结论；也可选中回答建立核验卡片。')}</p>`, key + run.analysis.claimsError);
    const verifications = run.verifications || [];
    setRenderedContent($('verificationList'), () => [...verifications].reverse().map(v => `<article class="verification-card" data-verification-id="${esc(v.id)}" data-document-id="${esc(v.documentId)}" data-extraction-version="${run.document.extractionVersion || 1}" data-status="${esc(v.status)}" data-verdict="${esc(v.verdict || '')}"><header><strong>${esc(v.verdict || statusName(v.status))}</strong><span>${esc(v.model)} · ${v.mode === 'image' ? '原图与局部' : v.mode === 'investigate' ? '按缺口补查' : '文字证据'} · ${esc(v.coverage || '')}${v.reader ? ` · 视觉读取 ${esc(v.reader)}` : ''}${v.sameReader ? ' · 与读取为同一模型' : ''}</span></header><p class="muted">${esc(v.claimText || run.claims.find(c => c.id === v.claimId)?.text || '')}</p>${v.phase ? `<p class="evidence-phase" role="status">${esc(v.phase)}</p>` : ''}<div class="markdown">${v.text ? renderMarkdown(v.text) : esc(v.error || '收到正文后实时显示…')}</div>${v.gaps?.length ? `<p class="evidence-gaps">仍缺：${esc(v.gaps.join('；'))}</p>` : ''}${v.visualLimitation ? `<p class="muted">${esc(v.visualLimitation)}</p>` : ''}${v.referenceWarning ? `<p class="evidence-gaps">${esc(v.referenceWarning)}</p>` : ''}<footer>${button('证据记录', 'evidence-records', v.id)}${button('存入笔记', 'note-verification', v.id)}${v.mode !== 'investigate' && ['证据不足','部分支持'].includes(v.verdict) ? button('补查缺口', 'investigate-claim', v.claimId) : ''}<span>${esc(statusName(v.status))} · 版本 ${v.version || 1} · ${v.callCount || v.segments?.length || 0} 次调用</span></footer></article>`).join(''), JSON.stringify(verifications));
    $('evidencePanel').querySelectorAll('[data-ws^="verify"],[data-ws="investigate-claim"],[data-ws="follow-claim"],#verifySelected,#rebuildClaims').forEach(b => { b.disabled = state.busy; });
    window.PaperDesktop?.render(run);
  }
  const pendingStatus = status => ['waiting', 'running', 'continuing'].includes(status);
  async function verify(claimIds, mode) {
    if (state.busy) return;
    if (!claimIds.length) return toast('请先选择需要核验的结论。');
    let model = $('verifyModel').value;
    if (mode === 'image' && !state.vision.models.some(x => x.model === model && x.verified)) model = $('visionReader').value;
    $('verifyMode').value = mode; $('verifyModel').value = model;
    state.busy = true; updateControls();
    try { const task = await api(`/api/turns/${state.run.id}/verify`, { method: 'POST', json: { requestId: crypto.randomUUID(), claimIds, mode, model, reader: $('localReader')?.value || $('visionReader').value } }); window.PaperDesktop?.tab('evidence'); await watch(task.id); }
    catch (error) { state.busy = false; updateControls(); throw error; }
  }
  async function notes() {
    if (!state.activeDocumentId) return;
    ws.notes = (await api(`/api/notes?documentId=${state.activeDocumentId}`)).notes;
    dialog('阅读笔记', `<p>${button('新建笔记', 'new-note')}</p>` + (ws.notes.map(n => `<article class="saved-note" data-document-id="${esc(n.documentId)}" data-extraction-version="${n.source?.extractionVersion || 1}"><h3>${esc(n.title)}</h3><div class="markdown">${renderMarkdown(n.text)}</div><div>${button('编辑', 'edit-note', n.id)}${button('删除', 'delete-note', n.id)}</div></article>`).join('') || '<p class="muted">选中回答或原文后可加入笔记。</p>'));
  }
  function editNote(note = {}) {
    dialog(note.id ? '编辑笔记' : '加入阅读笔记', `<form id="noteForm"><label>标题<input id="noteTitle" value="${esc(note.title || '阅读笔记')}" maxlength="100"></label><label>内容<textarea id="noteText" rows="14" required>${esc(note.text || '')}</textarea></label><p class="muted">支持 Markdown 和 LaTeX，引用会随笔记保存。</p><button class="button button-primary">保存笔记</button></form>`);
    $('noteForm').onsubmit = event => { event.preventDefault(); invoke(async () => { await api('/api/notes', { method: 'POST', json: { id: note.id, documentId: state.activeDocumentId, text: $('noteText').value, title: $('noteTitle').value, source: note.source || { turnId: state.run?.id } } }); await notes(); toast('笔记已保存到本机。'); }); };
  }
  async function history(all = false) {
    const conversations = (await api('/api/conversations' + (!all && state.activeDocumentId ? `?documentId=${state.activeDocumentId}` : ''))).conversations;
    const groups = await Promise.all(conversations.map(async c => ({ ...c, turns: (await api(`/api/conversations/${c.id}/turns`)).turns })));
    dialog('对话记录与分支', `<p>${button(all ? '只看当前论文' : '所有论文与待补传记录', all ? 'history-current' : 'history-all')}</p>` + (groups.map(c => `<section><h3>${esc(c.title)}${c.missingFile ? ' · 待补传原文件' : ''}</h3>${c.turns.map((t, i) => `<button class="turn-row ${state.run?.id === t.id ? 'active' : ''}" data-ws="open-turn" data-value="${t.id}"><strong>${esc(t.question)}</strong><span>${esc(t.document?.name || '')} · 第 ${i + 1} 轮 · ${t.parentTurnId ? '追问第 ' + (c.turns.findIndex(p => p.id === t.parentTurnId) + 1) + ' 轮' : '独立问题'}${state.run?.id === t.id ? ' · 当前阅读' : ''} · ${esc(statusName(t.status))} · ${esc(new Date(t.startedAt).toLocaleString('zh-CN'))}</span></button>`).join('')}</section>`).join('') || '<p>还没有已保存的对话。</p>'));
  }
  async function versions(generationId) {
    const data = await api(`/api/generations/${generationId}`);
    dialog('回答版本', data.versions.map(g => `<details ${g.id === generationId ? 'open' : ''}><summary>版本 ${g.version || 1} · ${esc(g.model)} · ${esc(statusName(g.status))} · ${esc(new Date(g.createdAt || Date.now()).toLocaleString('zh-CN'))}</summary><div class="markdown">${renderMarkdown(g.text || '')}</div></details>`).join(''));
  }
  function scrollHighlight() { const box = $('pdfHighlights')?.firstElementChild, wrap = $('sourceImageWrap'); if (box && wrap) wrap.scrollTop = Math.max(0, box.offsetTop - wrap.clientHeight / 3); }
  async function highlights() {
    if (!ws.ready || !state.sourceDocument) return;
    const request = ++ws.layoutRequest, documentId = state.sourceDocument.id, page = Number($('sourcePageSelect').value);
    $('pdfHighlights').innerHTML = ''; $('sourceLocationStatus').textContent = state.sourceParagraph ? '正在定位原文…' : '';
    try {
      const extractionVersion = state.sourceDocument.extractionVersion || 1;
      const data = await api(`/api/documents/${documentId}/pages/${page}/layout?extractionVersion=${extractionVersion}`); if (request !== ws.layoutRequest) return;
      const part = data.paragraphs.find(p => p.number === Number(state.sourceParagraph));
      $('pdfHighlights').innerHTML = (part?.boxes || []).map(b => `<span style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.width * 100}%;height:${b.height * 100}%"></span>`).join('');
      $('sourceLocationStatus').textContent = part ? part.located ? `已定位 [${part.id}] · ${part.boxes.length} ${data.granularity === 'block' ? '处版面区域（MinerU）' : '行原文'}` : part.reason || '仅可定位到页面' : '选择段落可在原始 PDF 页面高亮对应文字。';
      scrollHighlight();
      if (extractionVersion === state.sourceDocument.currentExtractionVersion) await api(`/api/documents/${documentId}`, { method: 'PATCH', json: { readingPosition: { page, paragraph: state.sourceParagraph, view: state.sourceView, extractionVersion } } });
    } catch (error) { if (request === ws.layoutRequest) $('sourceLocationStatus').textContent = error.message; }
  }
  async function exportReport(format) {
    const scope = $('exportScope').value; let turns = state.run ? [state.run] : [], notesList = [];
    if (scope === 'conversation' && ws.conversation) turns = (await api(`/api/conversations/${ws.conversation}/turns`)).turns;
    if (scope === 'notes') { turns = []; notesList = (await api(`/api/notes?documentId=${state.activeDocumentId}`)).notes; }
    const groups = new Map();
    for (const t of turns) groups.set(t.document.id + ':' + (t.document.extractionVersion || 1), { documentId: t.document.id, version: t.document.extractionVersion || 1 });
    for (const n of notesList) groups.set(n.documentId + ':' + (n.source?.extractionVersion || 1), { documentId: n.documentId, version: n.source?.extractionVersion || 1 });
    const referenced = new Set(turns.flatMap(t => [...t.answers.flatMap(g => g.evidenceIds || []), ...(t.claims || []).flatMap(c => (c.evidence || []).map(e => e.evidenceId)), ...(t.verifications || []).flatMap(v => v.evidenceIds || [])]).concat(notesList.flatMap(n => n.source?.evidenceIds || [])));
    const readingIds = new Set(turns.flatMap(t => (t.verifications || []).flatMap(v => (v.readings || []).map(r => r.readingId))).concat(notesList.map(n => n.source?.readingId)));
    const evidence = [], readings = [], exportLimitations = [];
    for (const group of groups.values()) {
      const suffix = '?extractionVersion=' + group.version;
      try {
        const [sources, saved] = await Promise.all([api('/api/documents/' + group.documentId + '/evidence' + suffix), api('/api/documents/' + group.documentId + '/readings' + suffix)]);
        evidence.push(...(sources.evidence || []).filter(e => referenced.has(e.id))); readings.push(...(saved.readings || []).filter(r => readingIds.has(r.id)));
      } catch { exportLimitations.push(`原文 v${group.version} 的统一证据记录暂不可用，已保留历史正文、引用和来源快照。`); }
    }
    const calls = g => g.segments?.length ? `\n\n#### ${g.model} · ${g.kind === 'analysis' ? '分析' : g.kind === 'verification' ? '核验' : '回答'}调用记录\n\n版本 ${g.version || 1}；生成 ID：${g.id}\n\n| 片段 | 类型 | 状态 / 结束原因 | tokens |\n| --- | --- | --- | --- |\n${g.segments.map((s, i) => `| ${i + 1} | ${s.automatic ? '自动续写' : i ? '手动继续' : '首次调用'} | ${s.status} / ${s.finishReason || '未返回'} | ${s.usage?.total_tokens ?? '未返回'} |`).join('\n')}` : '';
    let markdown = turns.map(t => reportMarkdown(t) + `\n\n对话 ID：${t.conversationId}；轮次 ID：${t.id}；父轮次：${t.parentTurnId || '无'}\n` + (t.selection ? `\n用户引用的附加材料：\n\n${t.selection}\n` : '') + '\n\n' + (t.claims || []).map(c => `### 待核验结论\n${c.text}\n${(c.evidence || []).map(r => `[${r.ref}]（${r.valid ? '引用存在' : '引用无效'}）`).join(' ')}\n${(c.positions || []).map(p => `${p.model}：${p.text}`).join('\n')}\n待核验：${c.question || '结论是否得到原文支持'}`).join('\n\n') + '\n\n' + (t.verifications || []).map(v => `### 核验：${v.verdict || statusName(v.status)}\n模型：${v.model}；方式：${v.mode}；范围：${v.coverage || ''}；与转录同模型：${v.sameReader ? '是' : '否'}\n\n待核验结论：${v.claimText || t.claims?.find(c => c.id === v.claimId)?.text || '未保存'}\n\n核验版本：${v.version || 1}；核验 ID：${v.id}${v.previousId ? `；前一版本：${v.previousId}` : ''}\n引用有效性（程序检查）：${(v.references || []).map(r => `${r.ref}（${r.valid ? '存在' : '无效'}）`).join('、') || '未提供'}\n${v.resultReferences?.length ? '核验正文引用检查：' + v.resultReferences.map(r => `${r.ref}（${r.valid ? r.provided ? '存在且已提供' : '存在，未提供' : '不存在'}）`).join('、') : ''}\n${v.referenceWarning || ''}\n\n${v.text || v.error || '未生成正文'}`).join('\n\n') + [...t.answers, t.analysis, ...(t.verifications || [])].map(calls).join('') + Object.values(t.memories || {}).map(m => `\n\n### ${m.model} 历史摘要\n覆盖轮次：${m.turns.join('、')}；用量：${m.usage?.total_tokens ?? '未返回'} tokens\n\n${m.text}`).join('')).join('\n\n---\n\n') + notesList.map(n => `# ${n.title}\n\n${n.text}`).join('\n\n---\n\n');
    markdown += (evidence.length ? '\n\n## 原文证据记录\n\n' + evidence.map(e => '[' + e.ref + '] · 原文 v' + e.extractionVersion + ' · 证据 ID：' + e.id + '\n\n' + e.text).join('\n\n') : '') + (readings.length ? '\n\n## 局部精读（模型衍生资料）\n\n' + readings.map(r => r.label + ' · ' + r.model + ' · [' + r.ref + '] · 原文 v' + r.extractionVersion + '\n\n' + r.text).join('\n\n') : '');
    markdown += turns.flatMap(t => (t.verifications || []).filter(v => v.mode === 'investigate').map(v => '\n\n### 证据补查记录\n核验 ID：' + v.id + '；核验模型：' + v.model + '；视觉读取：' + v.reader + '；调用：' + v.callCount + '；停止原因：' + v.stopReason + '\n' + v.rounds.map(r => '第 ' + r.index + ' 轮：' + r.refs.map(x => '[' + x + ']').join(' ') + '\n检索：' + r.queries.join('；')).join('\n') + '\n仍缺：' + (v.gaps || []).join('；'))).join('');
    markdown += exportLimitations.length ? '\n\n导出说明：' + exportLimitations.join('；') : '';
    const text = format === 'json' ? JSON.stringify({ scope, document: activeDocument() || state.run?.document, turns, notes: notesList, evidence, readings, exportLimitations }, null, 2) : format === 'html' ? await reportHtml(state.run || { document: activeDocument() }, markdown) : markdown;
    const blob = new Blob([text], { type: format === 'html' ? 'text/html;charset=utf-8' : format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${activeDocument()?.name || '论文'}-${scope}.${format === 'markdown' ? 'md' : format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); $('exportDialog').close();
  }
  function bind() {
    $('newConversation').onclick = () => { ws.conversation = null; ws.parent = null; ws.onlyModel = null; ws.selection = ''; ws.turns = []; state.run = null; $('resultsSection').hidden = true; $('emptyState').hidden = false; $('conversationSelect').value = ''; banner(); $('question').value = ''; $('question').placeholder = '为这篇论文提出一个新问题'; updateControls(); window.PaperDesktop?.render(); window.PaperDesktop?.compose(true, true); };
    $('conversationSelect').onchange = () => invoke(async () => { ws.conversation = $('conversationSelect').value || null; if (!ws.conversation) return $('newConversation').click(); ws.parent = null; ws.onlyModel = null; ws.selection = ''; banner(); await loadConversation(); });
    $('turnHistory').onclick = () => invoke(history); $('notesBtn').onclick = () => invoke(notes);
    $('readingStatus').onchange = () => invoke(() => api(`/api/documents/${state.activeDocumentId}`, { method: 'PATCH', json: { readingStatus: $('readingStatus').value } }));
    $('librarySearchBtn').onclick = () => invoke(async () => { const data = await api('/api/library/search?q=' + encodeURIComponent($('librarySearch').value)); dialog('论文库搜索', data.results.map(r => `<button class="turn-row" data-ws="search-result" data-value="${esc(r.id)}" data-kind="${esc(r.kind)}" data-document="${esc(r.documentId)}"><strong>${esc(r.title.slice(0, 120))}${r.title.length > 120 ? '…' : ''} · ${r.kind === 'document' ? '原文' : r.kind === 'note' ? '笔记' : '问答'}</strong><span>${esc(r.excerpt)}</span></button>`).join('') || '<p>没有匹配的记录。</p>'); });
    $('librarySearch').onkeydown = e => { if (e.key === 'Enter') $('librarySearchBtn').click(); };
    $('continueAnalysis').onclick = () => invoke(() => outputAction(state.run.analysis.id, 'continue'));
    $('analysisVersions').onclick = () => invoke(() => versions(state.run.analysis.id));
    $('verifySelected').onclick = () => invoke(() => verify([...$('claimList').querySelectorAll('input:checked')].map(x => x.value), $('verifyMode').value));
    $('verifyMode').onchange = () => { const image = $('verifyMode').value === 'image'; [...$('verifyModel').options].forEach(o => { o.disabled = image && !state.vision.models.some(x => x.model === o.value && x.verified); }); $('verifyModel').value = image ? $('visionReader').value : state.run?.reviewer; };
    $('rebuildClaims').onclick = () => invoke(async () => { if (state.busy) return; state.busy = true; updateControls(); try { const task = await api(`/api/turns/${state.run.id}/claims`, { method: 'POST', json: {} }); await watch(task.id); } catch (error) { state.busy = false; updateControls(); throw error; } });
    $('sourcePanelWidth').oninput = () => window.PaperDesktop?.syncLayout();
    $('sourceDialog').addEventListener('close', () => { state.sourceRequest = (state.sourceRequest || 0) + 1; document.body.classList.remove('source-open'); window.PaperDesktop?.syncLayout(); $('selectionTools').hidden = true; returnToReader(); });
    document.addEventListener('mouseup', event => {
      if (event.target.closest('.selection-tools')) return;
      const selectedRange = window.getSelection(), selection = selectedRange?.toString().trim();
      if (!selection || !event.target.closest('.markdown,.source-text')) { $('selectionTools').hidden = true; return; }
      ws.selectionText = selection.slice(0, 12000);
      ws.selectionSource = event.target.closest('#sourceText') ? { extractionVersion: state.sourceDocument.extractionVersion || 1 } : { turnId: state.run?.id, extractionVersion: state.run?.document.extractionVersion || 1 };
      if (event.target.closest('#sourceText')) { const range = selectedRange.getRangeAt(0), prefix = `${state.sourceDocument.sourceType === 'page' ? 'P' : 'S'}${$('sourcePageSelect').value}`, paragraphs = [...$('sourceText').querySelectorAll('.source-paragraph')].filter(p => range.intersectsNode(p)); const refs = paragraphs.length ? paragraphs.map(p => `[${prefix}.${p.dataset.paragraphNumber}]`).join(' ') : `[${prefix}]`; ws.selectionText = `论文《${state.sourceDocument.name}》原文 v${state.sourceDocument.extractionVersion || 1}：\n${ws.selectionText} ${refs}`; }
      else if (event.target.closest('#sourceReading,.reading-full')) { const context = event.target.closest('[data-extraction-version]'); ws.selectionSource = { extractionVersion: Number(context?.dataset.extractionVersion) || 1 }; ws.selectionText = `论文局部精读（模型生成的衍生资料，非原文；原文 v${ws.selectionSource.extractionVersion}）：\n${ws.selectionText}`; }
      else { const card = event.target.closest('[data-answer-index]'), index = card ? Number(card.dataset.answerIndex) : event.target.closest('#answerDialog') && state.reader?.type === 'answer' ? state.reader.index : null, answer = index !== null && state.run?.answers[index]; ws.selectionText = `${answer ? `${answer.model} 的回答（版本 ${answer.version || 1}）` : '当前分析 / 核验结果'}，问题：${state.run?.question || ''}\n引用资料：${ws.selectionText}`; }
      (event.target.closest('dialog') || document.body).append($('selectionTools'));
      $('selectionLabel').textContent = `选中 ${formatNumber(selection.length)} 字`;
      const bounds = selectedRange.getRangeAt(0).getBoundingClientRect();
      $('selectionTools').hidden = false;
      const tools = $('selectionTools'), source = $('sourceDialog').open && event.target.closest('#sourceDialog');
      const rightEdge = source ? innerWidth - 12 : $('sourceDialog').open ? $('sourceDialog').getBoundingClientRect().left - 12 : innerWidth - 12;
      tools.style.left = Math.max(12, Math.min(bounds.left, rightEdge - tools.offsetWidth)) + 'px';
      tools.style.top = Math.max(12, Math.min(bounds.bottom + 8, innerHeight - tools.offsetHeight - 16)) + 'px';
    });
    $('selectionTools').addEventListener('mousedown', event => event.preventDefault());
    document.addEventListener('keydown', event => { if (event.key === 'Escape') $('selectionTools').hidden = true; });
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-ws]'); if (!target) return;
      const action = target.dataset.ws, value = target.dataset.value;
      invoke(async () => {
        if (action === 'continue' || action === 'retry') return outputAction(value, action);
        if (action === 'versions') return versions(value);
        if (action === 'provenance') {
          const a = [...state.run.answers, state.run.analysis].find(a => a.id === value); if (!a) return; const audit = a.inputAudit;
          dialog(`${a.model} · 上下文与生成片段`, `<p>${esc(metrics(a))} · ${a.callCount || a.segments?.length || 0} 次调用${a.inputChars ? ` · 输入约 ${formatNumber(Math.ceil(a.inputChars / 2))} tokens（估算）` : ''}</p><p>${audit ? `历史仅包含 ${esc(audit.model)} 自己的回答及共同问题；${audit.history.length} 轮 · ${formatNumber(audit.historyChars)} 字符${audit.explicitSelection ? ' · 本轮含用户主动引用的附加资料' : ''}。` : '此记录生成于上下文审计功能启用前。'}</p>` + (audit ? `<div class="context-audit">${audit.history.map(h => `<p>${button(h.turnId.slice(0, 8), 'open-turn', h.turnId)} · 回答 ${esc(h.generationId?.slice(0, 8) || '本模型未参与')}</p>`).join('') || '<p>首轮问题，没有历史回答。</p>'}</div>` : '') + (a.segments || []).map((s,i) => `<details><summary>第 ${i+1} 段 · ${s.automatic ? '自动续写' : i ? '手动继续' : '首次生成'} · ${esc(s.finishReason || statusName(s.status))} · ${s.usage?.total_tokens ?? '未返回'} tokens</summary><div class="markdown">${renderMarkdown(s.text)}</div></details>`).join('')); return;
        }
        if (action === 'claim-source') { const c = state.run.claims.find(c => c.id === value), r = c.evidence?.find(r => r.valid); if (!r) return toast('这条结论没有有效引用，请先核验文字证据。'); return openSource(r.page, r.documentId, state.run.document.sourceType === 'page' ? 'P' : 'S', r.paragraph, r.extractionVersion || state.run.document.extractionVersion || 1); }
        if (action === 'history-all' || action === 'history-current') return history(action === 'history-all');
        if (action === 'follow-model') { ws.onlyModel = value; ws.parent = state.run.id; ws.selection = ''; banner(); window.PaperDesktop?.compose(true, true); $('question').focus(); $('questionForm').scrollIntoView({ block: 'start' }); }
        if (action === 'follow-all') { ws.onlyModel = null; banner(); window.PaperDesktop?.compose(true, true); }
        if (action === 'clear-selection') { ws.selection = ''; banner(); }
        if (action === 'clear-follow') { ws.parent = null; ws.selection = ''; ws.onlyModel = null; banner(); window.PaperDesktop?.compose(true, true); }
        if (action === 'selection-dismiss') { $('selectionTools').hidden = true; window.getSelection()?.removeAllRanges(); }
        if (action === 'selection-follow') { ws.onlyModel = null; ws.selection = ws.selectionText; ws.parent = state.run?.id || null; banner(); $('selectionTools').hidden = true; ws.sourceReturn = null; $('sourceDialog').close(); $('answerDialog').close(); $('workspaceDialog').close(); window.PaperDesktop?.compose(true, true); $('question').focus(); }
        if (action === 'selection-note') { $('selectionTools').hidden = true; editNote({ text: ws.selectionText, source: ws.selectionSource }); }
        if (action === 'selection-claim') { if (state.busy) return toast('当前轮生成完成后可建立核验卡片。'); if (!state.run?.id) return toast('先完成一轮问答，再建立核验卡片。'); await api(`/api/turns/${state.run.id}/claims`, { method: 'POST', json: { text: ws.selectionText } }); showTurn(await api(`/api/turns/${state.run.id}`)); $('selectionTools').hidden = true; }
        if (action === 'note-answer') editNote({ text: state.run.answers[Number(value)].text, title: state.run.question.slice(0, 100) });
        if (action === 'note-verification') { const v = state.run.verifications.find(v => v.id === value); editNote({ text: v?.text || '', source: { turnId: state.run.id, verificationId: value, evidenceIds: v?.evidenceIds || [], extractionVersion: state.run.document.extractionVersion || 1 } }); }
        if (action === 'evidence-records') return window.PaperEvidence?.provenance(state.run.verifications.find(v => v.id === value));
        if (action === 'investigate-claim') return verify([value], 'investigate');
        if (action === 'verify-claim') return verify([value], $('verifyMode').value);
        if (['verify-text', 'verify-image'].includes(action)) return verify([value], action === 'verify-image' ? 'image' : 'text');
        if (action === 'follow-claim' || action === 'note-claim') { const c = state.run.claims.find(x => x.id === value), text = `${c.text}\n${(c.refs || []).map(r => `[${r}]`).join(' ')}`; if (action === 'note-claim') editNote({ text }); else { ws.onlyModel = null; ws.selection = text; ws.parent = state.run.id; banner(); window.PaperDesktop?.compose(true, true); $('question').focus(); $('questionForm').scrollIntoView(); } }
        if (action === 'new-note') editNote();
        if (action === 'edit-note') editNote(ws.notes.find(n => n.id === value));
        if (action === 'delete-note' && confirm('删除这条笔记？')) { await api(`/api/notes/${value}`, { method: 'DELETE' }); await notes(); }
        if (action === 'clear-cache') { await api('/api/library/clear-cache', { method: 'POST', json: {} }); await library(); toast('可再生成缓存已清理，论文和阅读记录已保留。'); }
        if (action === 'open-turn') {
          const turn = await api(`/api/turns/${value}`); ws.stream?.close(); ws.taskId = null; state.busy = false;
          state.activeDocumentId = turn.document.id; await documentChanged(true); ws.stream?.close(); ws.taskId = null; state.busy = false; showTurn(turn); renderDocuments();
          $('workspaceDialog').close();
          if (turn.status === 'running' && turn.taskId) await watch(turn.taskId);
        }
        if (action === 'search-result') {
          state.activeDocumentId = target.dataset.document; await documentChanged(true);
          if (target.dataset.kind === 'turn') showTurn(await api(`/api/turns/${value}`));
          if (target.dataset.kind === 'note') await notes(); else { $('workspaceDialog').close(); if (target.dataset.kind === 'document') await openSource(); }
        }
      });
    });
  }
  async function init() {
    if (ws.ready) return; inject(); ws.ready = true; bind(); window.PaperDesktop?.init(); window.PaperEvidence?.init();
    const oldRender = renderDocuments; renderDocuments = function() { oldRender(); if (ws.ready && ws.doc !== state.activeDocumentId) invoke(() => documentChanged()); };
    const oldControls = updateControls; updateControls = function() { oldControls(); ['newConversation', 'conversationSelect', 'turnHistory'].forEach(id => $(id).disabled = state.busy); window.PaperDesktop?.render(); if (state.run?.conversationId) $('retryAnalysisBtn').disabled = state.busy || !state.config?.keyConfigured || state.run.answers.filter(a => a.text).length < 2; };
    const oldSource = openSource; openSource = async function(number, documentId, kind, paragraph, extractionVersion) {
      const viewport = document.scrollingElement, readingTop = viewport?.scrollTop;
      const savedView = !number ? activeDocument()?.readingPosition?.view : null;
      if (!number && activeDocument()?.readingPosition) { const pos = activeDocument().readingPosition; number = pos.page; paragraph = pos.paragraph; }
      const origin = document.querySelector('dialog[open]:not(#sourceDialog)');
      if (origin) { ws.sourceReturn = { id: origin.id, scroll: origin.querySelector('.expanded-answer,#workspaceDialogBody')?.scrollTop || 0, reader: state.reader, fullscreen: origin.classList.contains('reader-fullscreen'), ...(origin.id === 'workspaceDialog' ? { title: $('workspaceDialogTitle').textContent, html: $('workspaceDialogBody').innerHTML } : {}) }; origin.close(); }
      try { await oldSource(number || 1, documentId || state.activeDocumentId, kind, paragraph, extractionVersion); }
      finally { if (origin && !$('sourceDialog').open) returnToReader(); }
      if (!$('sourceDialog').open) return;
      state.sourceView = state.sourceDocument.visualAvailable ? savedView === 'text' ? 'text' : 'image' : 'text'; renderSourcePage();
      if (innerWidth >= 1000) document.body.classList.add('source-open');
      window.PaperDesktop?.syncLayout();
      if (viewport && Number.isFinite(readingTop)) viewport.scrollTop = readingTop;
    };
    const oldSourceRender = renderSourcePage; renderSourcePage = function() { oldSourceRender(); invoke(highlights); invoke(() => window.PaperEvidence?.sourceChanged()); };
    for (const run of state.history) { try { await api('/api/library/import', { method: 'POST', json: { runs: [run] } }); } catch (error) { toast(`旧历史导入未完成：${error.message}。浏览器原记录仍保留。`); break; } }
    ws.doc = state.activeDocumentId; await library(); await documentChanged(true);
  }
  function showComposer() { ws.sourceReturn = null; $('sourceDialog').close(); $('answerDialog').close(); $('workspaceDialog').close(); window.PaperDesktop?.compose(true, true); }
  return { editNote, showComposer, context: () => ws, refreshBanner: banner, init, ask, render, library, history, exportReport, documentChanged, cancel: () => invoke(() => ws.taskId ? api(`/api/runs/${ws.taskId}/cancel`, { method: 'POST', json: {} }) : Promise.resolve()), retryAnalysis: () => invoke(() => outputAction(state.run.analysis.id, 'retry')), confirmDelete: () => confirm('删除这篇论文及其全部对话、笔记、转录、局部精读和核验记录？此操作无法撤销。') };
})();
