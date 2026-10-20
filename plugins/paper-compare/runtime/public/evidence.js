'use strict';
// Local source readings have their own tasks. They never change the active Q&A
// turn, model selection, branch or any model's conversation history.
window.PaperEvidence = (() => {
  let ready = false, request = 0, crop = false, opening = false, starting = false, openRequest = 0;
  const catalogues = new Map(), records = new Map(), streams = new Map(), focused = new Map();
  const esc = value => escapeHtml(value), key = d => `${d.id}:v${d.extractionVersion || 1}`;
  const sources = () => catalogues.get(key(state.sourceDocument || {})) || [];
  const selected = () => sources().find(o => o.paragraph === Number(state.sourceParagraph) && o.page === Number($('sourcePageSelect').value));
  const scope = () => state.sourceDocument ? { documentId: state.sourceDocument.id, extractionVersion: state.sourceDocument.extractionVersion || 1, ref: `${state.sourceDocument.sourceType === 'page' ? 'P' : 'S'}${$('sourcePageSelect').value}.${state.sourceParagraph}` } : null;
  const status = r => r?.phase || ({ done: '精读已保存', running: '正在精读', continuing: '正在生成', interrupted: '精读已中断', cancelled: '精读已停止', incomplete: '输出未完整', error: '精读失败' }[r?.status] || '');
  const attempt = async fn => { try { return await fn(); } catch (error) { toast(error.message); } };
  const sourceKey = r => `${r?.documentId}:${r?.extractionVersion}:${r?.ref}`;
  function readingFor(current) { return records.get(focused.get(sourceKey(current))) || [...records.values()].filter(r => r.documentId === current?.documentId && r.extractionVersion === current?.extractionVersion && r.ref === current?.ref).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]; }
  function putReading(reading, cached = false) { if (reading) { records.set(reading.id, { ...reading, reused: cached }); focused.set(sourceKey(reading), reading.id); } render(); }
  async function sourceChanged() {
    if (!ready || !state.sourceDocument) return;
    const current = state.sourceDocument, versionKey = key(current), ticket = ++request;
    if (!catalogues.has(versionKey)) {
      const data = await api(`/api/documents/${current.id}/objects?extractionVersion=${current.extractionVersion || 1}`);
      catalogues.set(versionKey, data.objects || []);
    }
    if (ticket !== request || key(state.sourceDocument) !== versionKey) return;
    const object = selected(), objects = sources();
    const value = object?.ref || '';
    const group = (label, items) => items.length ? `<optgroup label="${label}">${items.map(o => `<option value="${esc(o.ref)}">${esc(o.label)} · 第 ${o.page} 页 · ${esc(o.ref)}${o.region ? '' : '（页级）'}</option>`).join('')}</optgroup>` : '';
    const numbered = o => /^(?:公式|图|表)\s+\S/.test(o.label), page = Number($('sourcePageSelect').value);
    const html = '<option value="">选择图表或公式…</option>' + group('公式', objects.filter(o => o.type === 'equation')) + group('图表', objects.filter(o => o.type !== 'equation' && numbered(o))) + group('本页其他区域', objects.filter(o => o.page === page && o.type !== 'equation' && !numbered(o)));
    setRenderedContent($('sourceObjectSelect'), () => html, versionKey + ':' + page); $('sourceObjectSelect').value = value;
    $('sourcePrecision').hidden = !current.visualAvailable;
    $('sourceCropBtn').hidden = !object?.region;
    $('sourceReadBtn').disabled = !current.visualAvailable || !state.sourceParagraph || !$('localReader').value;
    $('sourceReadBtn').title = state.sourceParagraph ? `使用 ${$('localReader').value || '已验证视觉模型'} 读取整页与此处局部高清图，结果自动保存` : '先选择图表、公式或原文段落';
    if (!object?.region) crop = false;
    applyView(); render();
    const data = await api(`/api/documents/${current.id}/readings?extractionVersion=${current.extractionVersion || 1}`);
    for (const reading of data.readings || []) if (![...streams.values()].some(s => s.readingId === reading.id)) records.set(reading.id, reading);
    if (ticket !== request || key(state.sourceDocument) !== versionKey) return;
    for (const task of data.tasks || []) if (task.status === 'running' && !streams.has(task.id)) watch(task.id);
    render();
  }
  function applyView() {
    const object = selected(), showing = crop && object?.region && state.sourceView === 'image';
    $('sourceCropWrap').hidden = !showing; $('sourceCropBtn').classList.toggle('active', !!showing);
    if (showing) { $('sourceImageWrap').hidden = true; $('sourceText').hidden = true; $('sourceCropImage').src = paperUrl(`/api/evidence/${object.id}/image`); $('sourceCropImage').alt = `${object.label} [${object.ref}] 的原始 PDF 局部高清图`; $('sourceCropCaption').textContent = `${object.label} [${object.ref}] · 原文 v${object.extractionVersion} · 含少量边距`; }
  }
  function render() {
    if (!ready) return;
    const current = scope(), reading = readingFor(current), active = [...streams.values()].find(s => s.documentId === current?.documentId && s.extractionVersion === current?.extractionVersion && s.ref === current?.ref);
    $('sourceReadBtn').disabled = opening || starting || !state.sourceDocument?.visualAvailable || !state.sourceParagraph || !$('localReader').value || !!active;
    $('sourceReadBtn').textContent = active ? '正在精读…' : '精读此处';
    $('sourceReading').hidden = !reading && !active;
    if (reading) {
      const box = $('sourceReadingBody'), top = box.scrollTop;
      $('sourceReadingTitle').textContent = status(reading); $('sourceReadingMeta').textContent = `${reading.model} · ${reading.location?.region ? '整页 + 局部高清' : '整页读取'} · ${reading.reused ? '复用已保存结果 · 本次 0 次调用' : `${reading.callCount || 0} 次调用`} · v${reading.extractionVersion}`;
      setRenderedContent(box, () => renderMarkdown(reading.text || reading.error || '收到正文后实时显示…'), reading.text + reading.error); box.scrollTop = top;
      $('sourceReading').dataset.documentId = reading.documentId; $('sourceReading').dataset.extractionVersion = reading.extractionVersion;
      $('sourceReadingStop').hidden = !active; $('sourceReadingFull').disabled = !reading.text;
      $('sourceReadingNote').disabled = !reading.text; $('sourceReadingFull').dataset.readingId = reading.id; $('sourceReadingNote').dataset.readingId = reading.id;
    } else if (active) { $('sourceReadingTitle').textContent = '正在准备原始图片…'; $('sourceReadingMeta').textContent = ''; $('sourceReadingBody').textContent = ''; $('sourceReadingStop').hidden = false; }
  }
  function watch(taskId) {
    const stream = new EventSource(paperUrl(`/api/reading-tasks/${taskId}/events`)), item = { stream, seq: -1 }; streams.set(taskId, item);
    stream.addEventListener('snapshot', event => {
      const data = JSON.parse(event.data); if (data.task.seq <= item.seq) return; item.seq = data.task.seq;
      Object.assign(item, { documentId: data.task.documentId, extractionVersion: data.task.extractionVersion, ref: data.reading?.ref || item.ref, readingId: data.task.readingId });
      if (data.terminal) { stream.close(); streams.delete(taskId); }
      putReading(data.reading, data.task.cached);
      if (data.terminal && data.task.error) toast(data.task.error);
      render();
    });
    stream.onerror = () => { if (streams.has(taskId) && scope()?.ref === item.ref) $('sourceReadingMeta').textContent = '连接暂时中断，正在重连；精读继续在服务端运行。'; };
    return item;
  }
  async function start() {
    const current = scope(); if (!current || !state.sourceParagraph || $('sourceReadBtn').disabled) return;
    starting = true; render();
    try {
      const task = await api('/api/readings', { method: 'POST', json: { ...current, model: $('localReader').value, requestId: crypto.randomUUID() } });
      const item = watch(task.id); Object.assign(item, current); $('sourceReading').open = true; render();
    } finally { starting = false; render(); }
  }
  function fullReading(id) {
    const r = records.get(id); if (!r) return;
    $('workspaceDialogTitle').textContent = r.label || `局部精读 [${r.ref}]`;
    $('workspaceDialogBody').innerHTML = `<article class="reading-full" data-document-id="${esc(r.documentId)}" data-extraction-version="${r.extractionVersion}"><p class="muted">${esc(r.model)} · 原文 v${r.extractionVersion} · ${esc(r.ref)} · ${r.location?.region ? '整页 + 局部高清' : esc(r.location?.reason || '整页读取')} · ${r.callCount || 0} 次调用</p><p class="reading-disclaimer">这是模型从原图生成的精读记录。关键结论仍需发起证据核验。</p><div class="markdown">${renderMarkdown(r.text)}</div></article>`;
    $('workspaceDialog').showModal();
  }
  async function history() {
    const doc = state.sourceDocument; if (!doc) return;
    const data = await api(`/api/documents/${doc.id}/readings?extractionVersion=${doc.extractionVersion || 1}`);
    $('workspaceDialogTitle').textContent = '本篇论文的精读记录';
    $('workspaceDialogBody').innerHTML = `<p class="muted">原文 v${doc.extractionVersion || 1} · 已完成结果按原文、读取模型和接口范围复用。记录中不包含问答历史。</p><div data-document-id="${esc(doc.id)}" data-extraction-version="${doc.extractionVersion || 1}">${(data.readings || []).map(r => `<details><summary>${esc(r.label)} · ${esc(r.model)} · ${esc(status(r))}</summary><p class="muted">${renderMarkdown(`[${r.ref}]`)} · ${r.callCount || 0} 次调用 · 精读版本 ${r.version}</p><div class="markdown">${renderMarkdown(r.text || r.error || '暂无正文')}</div></details>`).join('') || '<p>选择图表、公式或原文段落后，点击“精读此处”。结果会自动保存。</p>'}</div>`;
    $('workspaceDialog').showModal();
  }
  async function provenance(verification) {
    const ids = verification.evidenceIds || [], version = verification.extractionVersion || verification.references?.[0]?.extractionVersion || state.run.document.extractionVersion || 1;
    const data = ids.length ? await api(`/api/documents/${verification.documentId}/evidence?extractionVersion=${version}&ids=${ids.join(',')}`) : { evidence: [] };
    data.evidence = ids.map(id => data.evidence?.find(e => e.id === id)).filter(Boolean);
    $('workspaceDialogTitle').textContent = '证据记录与补查范围';
    $('workspaceDialogBody').innerHTML = `<p class="muted">原文引用存在由程序检查；结论判定由模型给出。补查只接收当前结论和原文，不接收模型的历史回答。</p><p>实际核验模型：${esc(verification.model)}${verification.reader ? ` · 视觉读取：${esc(verification.reader)}` : ''} · ${verification.callCount || 0} 次调用${verification.usage?.total_tokens ? ' · ' + formatNumber(verification.usage.total_tokens) + ' tokens' : ''}</p>${verification.limits ? `<p class="muted">每项最多 ${verification.limits.rounds} 轮补查、${verification.limits.pages} 页、${verification.limits.regionReads} 处局部精读。</p>` : ''}${(verification.rounds || []).map(r => `<details><summary>第 ${r.index} 轮 · 提供 ${r.refs.length} 段 · 检索到 ${r.candidates.length} 个候选</summary><p>补查目标：${esc(r.gaps?.join('；') || '核对结论和原文')}</p><p>检索词：${esc(r.queries.join('；'))}</p><p>实际提供：${renderMarkdown(r.refs.map(x => `[${x}]`).join(' '))}</p><p class="muted">仅候选、未必读入：${esc(r.candidates.map(c => c.ref).join('、'))}</p></details>`).join('')}${(verification.readings || []).map(r => `<p class="muted">${esc(r.ref)} · ${esc(r.model)} · ${r.cached ? '复用精读 · 0 次调用' : `${r.callCount || 0} 次精读调用`} · ${esc(status(r))}</p>`).join('')}${verification.resultReferences?.length ? `<p class="muted">核验正文的引用检查：${verification.resultReferences.map(r => `${esc(r.ref)}（${r.valid ? r.provided ? '存在且已提供材料' : '存在，未提供材料' : '不存在'}）`).join('、')}</p>` : ''}<div data-document-id="${esc(verification.documentId)}" data-extraction-version="${version}">${(data.evidence || []).map(e => `<details class="source-record"><summary>${renderMarkdown(`[${e.ref}]`)} ${esc(e.label || '原文段落')} · v${e.extractionVersion}</summary><p class="muted">证据 ID：${esc(e.id)} · ${esc(e.provider)} · ${e.region ? '有局部坐标' : '页级来源'}</p><div class="markdown">${renderMarkdown(e.text)}</div></details>`).join('') || `<p>${verification.status === 'running' ? '正在整理缺口，尚未提供本次核验的原文材料。' : '旧记录尚未关联统一证据 ID，原有引用仍可直接打开。'}</p>`}</div>`;
    $('workspaceDialog').showModal();
  }
  function refreshModels() {
    if (!ready) return;
    const eligible = state.models.filter(visionVerified);
    const value = $('localReader').value || $('visionReader').value;
    $('localReader').innerHTML = eligible.length ? eligible.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('') : '<option value="">请先检测视觉模型</option>';
    if (eligible.includes(value)) $('localReader').value = value;
    render();
  }
  function init() {
    if (ready) return; ready = true;
    $('sourceLocationStatus').insertAdjacentHTML('beforebegin', '<div id="sourcePrecision" class="source-precision"><label class="object-picker"><span>精读对象</span><select id="sourceObjectSelect" aria-label="选择要精读的图表或公式"><option value="">选择图表或公式…</option></select></label><button id="sourceReadBtn" class="button button-primary button-small" type="button" disabled>精读此处</button></div>');
    $('sourceTextBtn').insertAdjacentHTML('afterend', '<button id="sourceCropBtn" type="button" hidden>局部高清</button>');
    $('sourceMenuItems').insertAdjacentHTML('beforeend', '<label class="menu-field">局部精读模型<select id="localReader" aria-label="局部精读模型"></select></label><button id="sourceReadingHistory" type="button">查看精读记录</button>');
    $('sourceImageWrap').insertAdjacentHTML('beforebegin', '<div id="sourceCropWrap" class="source-crop-wrap" hidden><img id="sourceCropImage" alt="论文原始局部高清图"><p id="sourceCropCaption" class="muted"></p></div>');
    $('sourceDialog').insertAdjacentHTML('beforeend', '<details id="sourceReading" class="source-reading" hidden><summary><strong id="sourceReadingTitle">精读记录</strong></summary><p id="sourceReadingMeta" class="muted"></p><div id="sourceReadingBody" class="markdown"></div><footer><span class="muted">模型精读资料 · 尚非核验结论</span><button id="sourceReadingStop" class="button button-small button-quiet" type="button" hidden>停止</button><button id="sourceReadingFull" class="button button-small button-quiet" type="button">阅读</button><button id="sourceReadingNote" class="button button-small button-quiet" type="button">存入笔记</button></footer></details>');
    $('sourceObjectSelect').onchange = () => attempt(async () => {
      const object = sources().find(o => o.ref === $('sourceObjectSelect').value); if (!object) return;
      const ticket = ++openRequest; crop = false; opening = true; render();
      try { await openSource(object.page, object.documentId, 'P', object.paragraph, object.extractionVersion); }
      finally { if (ticket === openRequest) { opening = false; render(); } }
    });
    $('sourceReadBtn').onclick = () => attempt(start);
    $('sourceReadingHistory').onclick = () => attempt(history);
    $('sourceReadingFull').onclick = () => fullReading($('sourceReadingFull').dataset.readingId);
    $('sourceCropImage').onerror = () => { $('sourceCropCaption').textContent = '局部高清图加载失败，可切回原始页面重试。'; };
    $('sourceReadingNote').onclick = () => { const r = records.get($('sourceReadingNote').dataset.readingId); if (!r) return; PaperWorkspace.editNote({ title: r.label || '局部精读', text: `${r.text}\n\n来源：[${r.ref}]；视觉读取模型：${r.model}；原文 v${r.extractionVersion}。模型精读资料，尚非核验结论。`, source: { readingId: r.id, evidenceIds: r.evidenceIds || [r.evidenceId], extractionVersion: r.extractionVersion } }); };
    $('sourceReadingStop').onclick = () => attempt(async () => { const current = scope(), entry = [...streams].find(([,s]) => s.documentId === current?.documentId && s.ref === current?.ref && s.extractionVersion === current?.extractionVersion); if (entry) await api(`/api/reading-tasks/${entry[0]}/cancel`, { method: 'POST', json: {} }); });
    $('sourceCropBtn').onclick = () => { crop = !crop; state.sourceView = 'image'; renderSourcePage(); };
    ['sourceImageBtn', 'sourceTextBtn'].forEach(id => $(id).addEventListener('click', () => { crop = false; applyView(); }));
    $('sourcePageSelect').addEventListener('change', () => { crop = false; });
    $('localReader').onchange = render;
    $('sourceText').addEventListener('click', e => { if (e.target.closest('button,a,input,summary,select') || window.getSelection()?.toString()) return; const p = e.target.closest('.source-paragraph'); if (p && Number(p.dataset.paragraphNumber) !== state.sourceParagraph) { state.sourceParagraph = Number(p.dataset.paragraphNumber); renderSourcePage(); } });
    refreshModels();
  }
  return { init, sourceChanged, refreshModels, provenance, render, records };
})();
