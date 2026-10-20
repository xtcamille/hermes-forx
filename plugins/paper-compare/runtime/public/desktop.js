'use strict';
// Desktop navigation and actions remain stable while streamed content changes.
window.PaperDesktop = (() => {
  let ready = false, view = 'answers', composerOpen = true, shownTurn = null;
  const labels = { answers: '模型回答', analysis: '对比分析', evidence: '证据核验', visual: '图表转录' };
  const pending = s => ['waiting', 'running', 'continuing'].includes(s);
  const unfinished = s => ['incomplete', 'interrupted', 'cancelled', 'error'].includes(s);
  const menu = (label, html, extra = '') => `<details class="action-menu ${extra}"><summary class="icon-button" role="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-expanded="false">${icon('more')}</summary><div class="action-menu-panel">${html}</div></details>`;
  function closeMenus(except = null, restore = false) {
    document.querySelectorAll('.action-menu[open]').forEach(m => { if (m !== except) { m.open = false; m.querySelector('summary').setAttribute('aria-expanded','false'); if (restore) m.querySelector('summary').focus(); } });
  }
  function positionMenu(m) {
    const panel = m.querySelector('.action-menu-panel'), r = m.querySelector('summary').getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth)) + 'px';
    const below = r.bottom + 6; panel.style.top = Math.max(8, below + panel.offsetHeight < innerHeight ? below : r.top - panel.offsetHeight - 6) + 'px';
  }
  function syncLayout() {
    const source = document.body.classList.contains('source-open'), sidebar = state.sidebarCollapsed ? 0 : 248;
    // Keep both panels available and reserve enough width for reading the answer.
    const preferred = Number($('sourcePanelWidth')?.value || 480), available = Math.max(360, (document.documentElement.clientWidth || innerWidth) - sidebar - 520);
    document.documentElement.style.setProperty('--source-width', Math.min(preferred, available) + 'px');
    document.body.classList.toggle('three-pane', source && !state.sidebarCollapsed);
    const sourceBtn = $('sourceBtn'); if (sourceBtn) { sourceBtn.classList.toggle('active', source); sourceBtn.setAttribute('aria-expanded', String(source)); }
  }
  function compose(open = true, focus = false) {
    composerOpen = open; $('questionForm').classList.toggle('composer-closed', !open);
    $('composeToggle').textContent = open && state.run ? '收起提问' : state.run ? '继续追问' : '提出问题';
    $('composeToggle').setAttribute('aria-expanded', String(open));
    if (focus) { $('questionForm').scrollIntoView({ block: 'start' }); $('question').focus(); }
  }
  function tab(value) {
    view = value; $('resultsSection').dataset.workbenchView = value;
    $('resultsSection').querySelector('.results-toolbar h2').firstChild.textContent = labels[value] + ' '; $('resultCount').hidden = value !== 'answers';
    document.querySelectorAll('[data-workbench-tab]').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.workbenchTab === value)); b.tabIndex = b.dataset.workbenchTab === value ? 0 : -1; });
    if (value === 'visual' && $('visualNotesDetails')) $('visualNotesDetails').open = true;
    if (state.run) compose(false);
    closeMenus();
  }
  function phase(run) {
    if (run.status === 'done' && [...run.answers, run.analysis].some(g => g.status === 'error')) return '部分模型失败 · 已保存';
    const verification = run.verifications?.filter(v => pending(v.status));
    if (verification?.length) return `核验中 · ${verification.length} 项正在处理`;
    if (run.memoryStatus) return run.memoryStatus;
    if (run.visual && pending(run.visual.status) || run.visual?.status === 'rendering') return `读取图表 · ${run.visual.completed || 0}/${run.visual.pages.length} 页`;
    if (run.status === 'running') {
      const answers = run.answers.filter(a => pending(a.status));
      if (answers.length) return answers.some(a => a.status === 'continuing') ? `正在${answers.some(a => a.status === 'continuing' && a.segments.at(-1)?.automatic) ? '自动续写' : '手动继续'} · 实时保存` : `并行回答 · ${run.answers.filter(a => a.status === 'done').length}/${run.answers.length} 已完成`;
      if (pending(run.analysis.status)) return run.analysis.text ? '对比分析中 · 实时保存' : run.claims?.length ? `整理结论 · ${run.claims.length} 条` : '分析思考中';
    }
    const count = [...run.answers, run.analysis].filter(a => unfinished(a.status)).length;
    return (run.status === 'done' && count ? `${count} 份内容待处理` : ({ done: '本轮完成', incomplete: '部分内容待继续', interrupted: '任务已中断', error: '任务未完成', cancelled: '任务已停止' }[run.status] || '等待生成')) + ' · 已保存';
  }
  function selectionCount() {
    const selected = $('claimList').querySelectorAll('input:checked').length, total = $('claimList').querySelectorAll('input[type=checkbox]').length;
    $('verifySelected').textContent = selected ? `核验选中 ${selected} 项` : '批量核验';
    $('verifySelected').disabled = state.busy || !selected;
    $('selectAllClaims').disabled = !total || state.busy;
    $('selectAllClaims').textContent = selected ? '取消选择' : total > 12 ? '选择前 12 项' : '全选';
    $('verifySelected').title = '先勾选结论；每批最多 12 条，同时处理 2 项';
  }
  function render(run = state.run) {
    if (!ready) return;
    const doc = activeDocument(); document.body.classList.toggle('has-paper', !!doc);
    $('paperHeading').textContent = doc?.name || '开始阅读一篇论文'; $('paperHeading').title = doc?.name || '';
    $('paperSummary').textContent = doc ? `${doc.pages} ${doc.sourceType === 'page' ? '页' : '段'}${doc.extraction?.provider === 'mineru' ? ' · MinerU 结构化解析' : ''} · ${[...state.selected].join('、') || '请在侧栏选择模型'}` : '上传论文，选择模型，再提出你的问题';
    $('notesBtn').disabled = !doc; $('paperMore').hidden = !doc;
    $('workbenchNav').hidden = !run; $('activeQuestion').hidden = !run;
    $('readingSettingsHint').textContent = `${$('visualMode').value === 'off' ? '全文文字' : $('visualMode').value === 'direct' ? '原始页面' : '共享转录'}${$('analyzeToggle').checked ? ' · 对比分析' : ''}`;
    syncLayout();
    const context = PaperWorkspace.context();
    $('askBtn').querySelector('span').textContent = context.onlyModel ? `向 ${context.onlyModel} 追问` : context.parent ? `向 ${state.selected.size} 个模型追问` : '开始并行提问';
    if (!run) { shownTurn = null; compose(true); $('turnTrail').innerHTML = ''; return; }
    if (shownTurn !== run.id) { shownTurn = run.id; compose(false); }
    if ((view === 'analysis' && run.analysis.status === 'off') || (view === 'visual' && !run.visual)) tab('answers');
    const qKey = run.id + ':' + run.question;
    setRenderedContent($('activeQuestion'), () => `<details><summary><span class="question-kind">${run.parentTurnId ? '追问' : '问题'}</span><strong>${escapeHtml(run.question)}</strong><span class="question-expand">展开问题</span></summary><div class="question-full">${escapeHtml(run.question)}</div></details>`, qKey);
    $('runStatus').textContent = phase(run); $('workbenchProgress').textContent = phase(run); $('workbenchProgress').classList.toggle('is-running', state.busy);
    $('workspaceStop').hidden = !state.busy; $('workspaceStop').disabled = !state.busy;
    $('composeToggle').disabled = state.busy;
    $('workbenchNav').querySelector('[data-workbench-tab="analysis"]').disabled = run.analysis.status === 'off';
    $('workbenchNav').querySelector('[data-workbench-tab="visual"]').disabled = !run.visual;
    $('evidenceCount').textContent = run.claims?.length || ''; $('answerTabCount').textContent = `${run.answers.filter(a => a.status === 'done').length}/${run.answers.length}`;
    $('analysisTabState').textContent = run.analysis.status === 'done' ? '' : run.analysis.status === 'waiting' ? '等待回答' : run.analysis.status === 'continuing' ? '续写中' : pending(run.analysis.status) ? '生成中' : run.analysis.status === 'off' ? '' : '待处理';
    $('continueAnalysis').hidden = !unfinished(run.analysis.status) || !run.analysis.text; $('fullscreenAnalysis').disabled = !run.analysis.text;
    const turns = PaperWorkspace.context().turns.filter(t => t.conversationId === run.conversationId);
    const items = [...turns.filter(t => t.id !== run.id), run].sort((a,b) => a.startedAt.localeCompare(b.startedAt));
    const trail = items.map((t,i) => `<button type="button" data-ws="open-turn" data-value="${escapeHtml(t.id)}" title="第 ${i+1} 轮：${escapeHtml(t.question)}" aria-current="${t.id === run.id ? 'step' : 'false'}" ${state.busy ? 'disabled' : ''}><span class="turn-number">${i + 1}</span><span>${escapeHtml(t.question.slice(0, 10))}${t.question.length > 10 ? '…' : ''}</span>${t.parentTurnId && items.some(x => x.id !== t.id && x.parentTurnId === t.parentTurnId) ? '<small>分支</small>' : ''}</button>`).join('');
    setRenderedContent($('turnTrail'), () => trail, trail);
    selectionCount(); $('verificationHint').hidden = !!run.verifications?.length;
    $('evidencePanel').classList.toggle('has-verifications', !!run.verifications?.length);
  }
  function organize() {
    const title = $('paperSidebar').querySelector('.section-title h2'); title.textContent = '论文库';
    $('paperSidebar').querySelector('.model-section h2').textContent = '回答模型';
    $('dropzone').innerHTML = `${icon('plus')}<strong>上传论文</strong><span>或拖入文件</span>`; $('dropzone').title = '支持 PDF、Word、TXT、Markdown，单个文件最大 50 MB';
    $('documentCount').insertAdjacentHTML('afterend', menu('论文库更多操作', '<div id="libraryMenuItems"></div>', 'library-menu'));
    const libraryItems = $('libraryMenuItems'); libraryItems.append($('demoBtn'));
    libraryItems.insertAdjacentHTML('beforeend','<button data-ws="clear-cache" type="button">清理可再生成缓存</button>');
    $('librarySearchBtn').innerHTML = icon('arrow'); $('librarySearchBtn').setAttribute('aria-label','搜索论文库');
    $('paperSidebar').querySelector('.sidebar-note strong').textContent = '本机保存';
    $('paperSidebar').querySelector('.sidebar-note p').textContent = '论文、问答、笔记与核验记录自动保存。';
    $('visionResultsBtn').textContent = '视觉能力'; $('visionResultsBtn').title = '查看当前网关模型的视觉检测结果';
    const bar = document.createElement('section'); bar.className = 'paper-bar';
    bar.innerHTML = '<div class="paper-identity"><h1 id="paperHeading"></h1><p id="paperSummary"></p></div><div class="paper-actions" id="paperActions"></div>';
    document.querySelector('.conversation-bar').before(bar);
    $('sourceBtn').className = 'button button-outlined button-small'; $('sourceBtn').innerHTML = icon('columns')+'<span>原文对照</span>'; $('sourceBtn').setAttribute('aria-controls','sourceDialog');
    $('paperActions').append($('sourceBtn'));
    $('paperActions').insertAdjacentHTML('beforeend', menu('论文更多操作','<label class="menu-field">阅读状态 <span id="readingStatusSlot"></span></label><div class="menu-separator"></div><div id="exportSlot"></div>', 'paper-menu'));
    $('paperActions').lastElementChild.id = 'paperMore'; $('readingStatusSlot').append($('readingStatus')); $('readingStatus').setAttribute('aria-label','论文阅读状态'); $('exportSlot').append($('exportBtn'));
    document.querySelector('.conversation-bar label:last-child').remove();
    $('newConversation').innerHTML = icon('plus'); $('newConversation').setAttribute('aria-label','新建独立对话'); $('newConversation').title = '新建独立对话';
    $('turnHistory').innerHTML = icon('history')+'<span>对话记录</span>';
    $('notesBtn').innerHTML = icon('note'); $('notesBtn').setAttribute('aria-label','阅读笔记'); $('notesBtn').title = '阅读笔记';
    document.querySelector('.conversation-bar label:first-child').firstChild.textContent = '';
    const settings = document.createElement('details'); settings.className = 'reading-settings'; settings.innerHTML = `<summary>${icon('settings')}阅读与生成设置<span id="readingSettingsHint"></span></summary><div class="reading-settings-body"><h3>图表与公式</h3></div>`;
    const vision = document.querySelector('.vision-options'), advanced = document.querySelector('.advanced-options'); vision.before(settings);
    const content = settings.querySelector('.reading-settings-body');
    [...vision.children].filter(n => n.tagName !== 'SUMMARY').forEach(n => content.append(n)); vision.remove();
    content.insertAdjacentHTML('beforeend','<h3>对比分析</h3>'); content.append(document.querySelector('.analysis-options'));
    content.insertAdjacentHTML('beforeend','<h3>输入与输出预算</h3>'); [...advanced.children].filter(n => n.tagName !== 'SUMMARY').forEach(n => content.append(n)); advanced.remove();
    settings.querySelector('summary').setAttribute('title','调整视觉阅读、分析模型、原文和输出预算');
    const stop = $('cancelBtn'); stop.hidden = true;
    const sourceControls = document.querySelector('.source-controls'), mode = document.querySelector('.source-mode');
    sourceControls.querySelector('label').firstChild.textContent = '';
    $('sourcePageSelect').setAttribute('aria-label','原文页码');
    sourceControls.insertAdjacentHTML('afterbegin', `<button id="sourcePrev" class="icon-button" type="button" aria-label="上一页">${icon('chevron-left')}</button>`);
    sourceControls.insertAdjacentHTML('beforeend', `<button id="sourceNext" class="icon-button" type="button" aria-label="下一页">${icon('chevron-right')}</button>`);
    mode.insertAdjacentHTML('beforeend', menu('原文更多操作','<div id="sourceMenuItems"></div>', 'source-menu'));
    const sm = $('sourceMenuItems'); $('sourceParagraphSelect').parentElement.classList.add('menu-field'); sm.append($('sourceParagraphSelect').parentElement, document.querySelector('.source-width-control'), $('sourceUsePageBtn'));
    $('sourceParagraphSelect').setAttribute('aria-label','定位原文段落'); $('sourcePanelWidth').value = 480;
    mode.append($('sourceZoomBtn')); $('sourceZoomBtn').innerHTML = icon('expand'); $('sourceZoomBtn').className = 'icon-button';
    // Page navigation and evidence mode belong on one compact row.
    sourceControls.append(mode); $('sourceDialog').append($('sourceCoverage'));
    $('sourceMeta').hidden = true;
    $('readerCopyBtn').innerHTML = icon('copy'); $('readerCopyBtn').setAttribute('aria-label','复制阅读内容'); $('readerCopyBtn').title = '复制阅读内容';
    const tools = document.querySelector('.analysis-tools'); tools.insertAdjacentHTML('beforeend', menu('分析更多操作', '<div id="analysisMenuItems"></div>'));
    $('analysisMenuItems').append($('copyAnalysis'), $('retryAnalysisBtn'), $('analysisVersions'));
    $('analysisMenuItems').insertAdjacentHTML('beforeend','<button id="analysisProvenance" type="button" data-ws="provenance">上下文与调用记录</button>');
    $('fullscreenAnalysis').textContent = '阅读'; $('fullscreenAnalysis').insertAdjacentHTML('afterbegin', icon('expand'));
    const ea = document.querySelector('.evidence-actions'); ea.insertAdjacentHTML('beforeend',menu('核验更多操作','<div id="evidenceMenuItems"></div>')); $('evidenceMenuItems').append($('rebuildClaims'));
    const st = $('selectionTools'); st.innerHTML = `<span id="selectionLabel">选中文字</span><button class="button button-primary button-small" type="button" data-ws="selection-follow">追问选段</button>${menu('选段更多操作','<button type="button" data-ws="selection-note">保存选段到笔记</button><button type="button" data-ws="selection-claim">建立核验卡片</button>')}<button class="icon-button" data-ws="selection-dismiss" type="button" aria-label="关闭选中文字操作">${icon('close')}</button>`;
  }
  function init() {
    if (ready) return;
    organize();
    $('questionForm').insertAdjacentHTML('beforebegin', `<nav id="turnTrail" class="turn-trail" aria-label="当前对话轮次"></nav><div id="workbenchNav" class="workbench-nav" hidden><div role="tablist" aria-label="阅读工作区">${Object.entries(labels).map(([key, label]) => `<button id="tab-${key}" type="button" role="tab" aria-selected="${key === view}" data-workbench-tab="${key}">${label} <small id="${key === 'answers' ? 'answerTabCount' : key === 'analysis' ? 'analysisTabState' : key === 'evidence' ? 'evidenceCount' : 'visualTabState'}"></small></button>`).join('')}</div><div class="workbench-controls"><button id="workspaceStop" class="button button-stop button-small" type="button" hidden>停止</button><button id="composeToggle" class="button button-primary button-small" type="button" aria-controls="questionForm">继续追问</button></div><div class="workbench-status"><span id="workbenchProgress" role="status"></span><span id="viewSlot"></span></div></div><section id="activeQuestion" class="active-question" hidden></section>`);
    $('viewSlot').append(document.querySelector('.results-actions .segmented')); $('resultsSection').dataset.workbenchView = view;
    $('questionForm').querySelector('.question-title').insertAdjacentHTML('beforeend', '<span class="shortcut-hint">⌘ / Ctrl + Enter 发送</span>');
    $('evidencePanel').querySelector('.evidence-actions').insertAdjacentHTML('afterbegin', '<button id="selectAllClaims" class="button button-quiet button-small" type="button">全选</button>');
    const body = document.createElement('div'); body.className = 'evidence-columns'; $('evidencePanel').append(body); body.append($('claimList'), $('verificationList'));
    $('verificationList').insertAdjacentHTML('beforebegin', '<p id="verificationHint" class="verification-hint">先点击引用对照原文，再选择核验方式。核验结果将在这里实时显示。</p>');
    $('workbenchNav').addEventListener('click', e => { const b = e.target.closest('[data-workbench-tab]'); if (b) tab(b.dataset.workbenchTab); });
    $('workbenchNav').addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight'].includes(e.key) || !e.target.matches('[role=tab]')) return;
      e.preventDefault(); const choices = [...$('workbenchNav').querySelectorAll('[role=tab]:not(:disabled)')], i = choices.indexOf(e.target), next = choices[(i + (e.key === 'ArrowRight' ? 1 : choices.length - 1)) % choices.length]; tab(next.dataset.workbenchTab); next.focus();
    });
    $('composeToggle').onclick = () => { if (!composerOpen) { const context = PaperWorkspace.context(); context.onlyModel = null; context.parent = state.run?.id || null; PaperWorkspace.refreshBanner(); } compose(!composerOpen, !composerOpen); };
    $('workspaceStop').onclick = () => PaperWorkspace.cancel();
    $('claimList').addEventListener('change', e => { if ($('claimList').querySelectorAll('input:checked').length > 12) { e.target.checked = false; toast('每批最多核验 12 条结论，请分批选择。'); } selectionCount(); });
    $('selectAllClaims').onclick = () => { const boxes = [...$('claimList').querySelectorAll('input[type=checkbox]')], checked = !boxes.some(b => b.checked); boxes.forEach((b,i) => b.checked = checked && i < 12); selectionCount(); };
    for (const [id,delta] of [['sourcePrev',-1],['sourceNext',1]]) $(id).onclick = () => { const select = $('sourcePageSelect'), i = select.selectedIndex + delta; if (i >= 0 && i < select.options.length) { select.selectedIndex = i; select.dispatchEvent(new Event('change',{bubbles:true})); } };
    document.addEventListener('toggle', e => { const m = e.target; if (!m.classList?.contains('action-menu')) return; m.querySelector('summary').setAttribute('aria-expanded', String(m.open)); if (m.open) { closeMenus(m); positionMenu(m); } }, true);
    document.addEventListener('click', e => { const m = e.target.closest('.action-menu'); if (!m || e.target.closest('.action-menu-panel button')) closeMenus(); });
    document.addEventListener('keydown', e => {
      const m = e.target.closest('.action-menu');
      if (e.key === 'Escape' && document.querySelector('.action-menu[open]')) { e.preventDefault(); e.stopPropagation(); closeMenus(null,true); return; }
      if (m && !e.target.matches('input,select,textarea') && ['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); m.open = true; positionMenu(m); const buttons = [...m.querySelectorAll('.action-menu-panel button:not(:disabled),.action-menu-panel select,.action-menu-panel input')]; if (!buttons.length) return; const i = buttons.indexOf(document.activeElement), index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length-1 : (i + (e.key === 'ArrowUp' ? buttons.length-1 : 1)) % buttons.length; buttons[index].focus(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !document.querySelector('dialog[open]:not(#sourceDialog)') && composerOpen && !state.busy) { e.preventDefault(); $('questionForm').requestSubmit(); }
    }, true);
    window.addEventListener('resize', () => { closeMenus(); syncLayout(); });
    document.addEventListener('scroll', e => { if (!e.target.closest?.('.action-menu-panel')) { closeMenus(); $('selectionTools').hidden = true; } }, true);
    ['visualMode','analyzeToggle'].forEach(id => $(id).addEventListener('change', () => render()));
    ready = true; render();
  }
  return { init, render, compose, tab, selectionCount, menu, syncLayout, unfinished };
})();
