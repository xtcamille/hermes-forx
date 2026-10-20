'use strict';

// The standalone app and the ForX plugin share these paths. A plugin page can
// be mounted below a private base URL without routing requests to the host API.
const paperUrl = path => path.startsWith('/') ? new URL('.', document.baseURI).pathname + path.slice(1) : path;
function paperStorage(type = 'local') {
  const store = type === 'session' ? sessionStorage : localStorage;
  const scope = document.querySelector('meta[name="paper-storage-scope"]')?.content;
  return scope ? { getItem: key => store.getItem(scope + ':' + key), setItem: (key, value) => store.setItem(scope + ':' + key, value), removeItem: key => store.removeItem(scope + ':' + key) } : store;
}
const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const state = { config: null, documents: [], activeDocumentId: null, models: [], selected: new Set(), busy: false,
  uploading: false, controller: null, run: null, history: [], sourceDocument: null, view: 'grid', modelError: '', vision: { models: [] }, probing: false, probeController: null, sourceView: 'image', sidebarCollapsed: false, reader: null, sourceParagraph: null, restoringCache: true };
const HISTORY_KEY = 'paper-compare-history-v1';
const DRAFT_KEY = 'paper-compare-draft-v1';
let toastTimer, renderTimer;
const renderedContent = new WeakMap();
function setRenderedContent(element, html, key) {
  const selection = typeof window !== 'undefined' && window.getSelection?.();
  if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return;
  if (renderedContent.get(element) !== key) { element.innerHTML = html(); renderedContent.set(element, key); }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function formatNumber(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function seconds(value) { return `${(Number(value || 0) / 1000).toFixed(1)}s`; }
function activeDocument() { return state.documents.find(doc => doc.id === state.activeDocumentId); }
function setSidebar(collapsed, persist = true) {
  state.sidebarCollapsed = collapsed;
  $('paperSidebar').hidden = collapsed;
  document.querySelector('.app-layout').classList.toggle('sidebar-collapsed', collapsed);
  $('sidebarToggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebarToggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  $('sidebarToggle').title = collapsed ? '展开侧栏' : '收起侧栏';
  $('collapsedSelection').hidden = !collapsed;
  $('collapsedSelection').textContent = `${activeDocument()?.name || '尚未选择论文'} · ${[...state.selected].join(' / ') || '尚未选择模型'}`;
  if (persist) try { paperStorage().setItem('paper-compare-sidebar-collapsed', String(collapsed)); } catch {}
  window.PaperDesktop?.syncLayout();
}

function saveDraft() {
  try { paperStorage('session').setItem(DRAFT_KEY, JSON.stringify({ documentId: state.activeDocumentId, question: $('question').value,
    selectedModels: [...state.selected], reviewer: $('reviewerSelect').value,
    temperature: $('temperature').value, maxTokens: $('maxTokens').value, contextBudget: $('contextBudget').value, analysisMaxTokens: $('analysisMaxTokens').value, analysisContextBudget: $('analysisContextBudget').value,
    visualMode: $('visualMode').value, visionReader: $('visionReader').value, visualSelection: $('visualSelection').value, visualPages: $('visualPages').value, maxVisualPages: $('maxVisualPages').value })); } catch {}
}
function contextBudgetHint() {
  const doc = activeDocument();
  if (!doc) { $('contextBudgetHint').textContent = '默认 250,000，上限 1,000,000 字符'; $('contextBudgetHint').className = ''; return; }
  const required = doc.contextChars || doc.chars + doc.pages * 20;
  const full = Number($('contextBudget').value) >= required;
  $('contextBudgetHint').textContent = `${full ? '可覆盖全部提取文字' : '当前预算将选取部分原文'} · 全文需 ${formatNumber(required)} 字符`;
  $('contextBudgetHint').className = full ? '' : 'partial-budget';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.config?.csrfToken || '';
  if (options.json !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.json); }
  const response = await fetch(paperUrl(path), { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function vendor(model) {
  const lower = model.toLowerCase();
  if (lower.includes('qwen')) return { letter: 'Q', className: 'vendor-q', name: 'Qwen' };
  if (lower.includes('deepseek')) return { letter: 'D', className: 'vendor-d', name: 'DeepSeek' };
  if (lower.includes('glm')) return { letter: 'G', className: 'vendor-g', name: 'GLM' };
  if (/kimi|^k[0-9]/.test(lower)) return { letter: 'K', className: 'vendor-k', name: 'Kimi' };
  if (lower.includes('mimo')) return { letter: 'M', className: 'vendor-m', name: 'MiMo' };
  if (lower.includes('step')) return { letter: 'S', className: 'vendor-s', name: 'Step' };
  if (/gpt|o[134]|openai/.test(lower)) return { letter: 'O', className: '', name: 'OpenAI' };
  if (lower.includes('claude')) return { letter: 'C', className: 'vendor-k', name: 'Claude' };
  if (lower.includes('gemini')) return { letter: 'G', className: 'vendor-d', name: 'Gemini' };
  return { letter: model.charAt(0).toUpperCase(), className: '', name: '自定义模型' };
}
function avatar(model) { const item = vendor(model); return `<span class="model-avatar ${item.className}">${escapeHtml(item.letter)}</span>`; }

function renderDocuments() {
  $('documentCount').textContent = `${state.documents.length} 份`;
  $('documentList').innerHTML = state.documents.map(doc => `<div class="document-row ${doc.id === state.activeDocumentId ? 'active' : ''}" data-document="${escapeHtml(doc.id)}" role="button" tabindex="0" aria-label="选择 ${escapeHtml(doc.name)}" aria-pressed="${doc.id === state.activeDocumentId}"><span class="document-icon">${icon('file')}</span><span class="document-info"><span class="document-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span><span class="document-meta">${doc.sourceType === 'page' ? `${doc.pages} 页` : `${doc.pages} 段`} · ${formatNumber(doc.chars)} 字符</span></span>${window.PaperDesktop?.menu ? PaperDesktop.menu(`${doc.name} 更多操作`, `<button class="danger-action" data-delete-document="${doc.id}" type="button">${icon('trash')}删除论文与阅读记录</button>`) : `<button class="icon-button" data-delete-document="${doc.id}" aria-label="移除 ${escapeHtml(doc.name)}">${icon('close')}</button>`}</div>`).join('');
  const doc = activeDocument();
  $('sourceBtn').hidden = !doc;
  $('paperBadge').textContent = doc ? doc.name : '请先上传论文';
  $('paperBadge').title = doc?.name || '';
  $('paperBadge').classList.toggle('loaded', !!doc);
  contextBudgetHint(); renderVisionControls(); setSidebar(state.sidebarCollapsed, false); updateControls();
}

function visionInfo(model) { return state.vision.models?.find(item => item.model === model); }
function visionVerified(model) { const item = visionInfo(model); return !!item && item.status === 'supported' && Date.now() - Date.parse(item.checkedAt || state.vision.checkedAt) < 7 * 86400000; }
function visionBadge(model) {
  const info = visionInfo(model), verified = visionVerified(model);
  const label = verified ? '视觉已验证' : info?.status === 'supported' ? '视觉需复检' : ['unavailable', 'unsupported'].includes(info?.status) ? '图片不可用' : info?.status === 'error' ? '检测失败' : info ? '视觉未验证' : '视觉待检测';
  return `<span class="vision-chip ${verified ? 'verified' : ''}" title="${escapeHtml(info?.reason || '尚未进行图片内容识别测试')}">${label}</span>`;
}
async function loadVision() {
  try { state.vision = await api('/api/vision'); renderVisionResults(); renderVisionControls(); renderModels(); }
  catch (error) { toast(`视觉检测信息读取失败：${error.message}`); }
}
function renderVisionControls() {
  const previous = $('visionReader').value;
  const models = state.models.filter(visionVerified);
  $('visionReader').innerHTML = models.length ? models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('') : '<option value="">请先检测视觉能力</option>';
  $('visionReader').value = models.includes(previous) ? previous : models.includes('k3') ? 'k3' : models[0] || '';
  const mode = $('visualMode').value, selection = $('visualSelection').value;
  $('visionReaderLabel').hidden = mode !== 'shared';
  $('maxVisualPagesLabel').hidden = selection !== 'auto' || mode === 'off';
  $('visualPagesLabel').hidden = selection !== 'manual' || mode === 'off';
  $('visualSelection').disabled = state.busy || mode === 'off';
  const doc = activeDocument();
  const unverified = [...state.selected].filter(model => !visionVerified(model));
  $('visualHint').textContent = !doc ? '上传 PDF 后，可读取原始页面中的图表、表格和公式。'
    : doc.format !== 'pdf' ? '此文件使用文字输入。需要图表和公式的原始版式时，请上传 PDF。'
    : mode === 'off' ? '本轮只提供提取文字，无法核验图片中的图表或完整公式。'
    : !doc.visualAvailable ? '旧版本没有保留原始 PDF，请补传一次相同文件；已有回答和页码引用会保留。'
    : mode === 'direct' && unverified.length ? `尚未通过视觉验证：${unverified.join('、')}。可使用共享视觉转录，或选择已验证模型。`
    : mode === 'shared' ? `由 ${$('visionReader').value || '已验证视觉模型'} 读取页面；${doc.scanned ? '此 PDF 没有提取文字，将主要依靠视觉转录。' : '全部回答模型与分析模型将收到相同的提取文字和视觉转录。'}`
    : '各回答模型接收相同的文字与页面图片；分析模型也需支持视觉才能核验原图。';
  $('visualHint').classList.toggle('warning', !!doc && mode !== 'off' && doc.format === 'pdf' && (!doc.visualAvailable || mode === 'direct' && unverified.length > 0));
  $('visionModelCount').textContent = `${models.length} 个视觉已验证`;
  window.PaperEvidence?.refreshModels();
}
function renderVisionResults() {
  $('visionResults').innerHTML = (state.vision.models || []).map(item => `<div class="vision-result"><div><strong>${escapeHtml(item.model)}</strong>${visionBadge(item.model)}</div><p>${escapeHtml(item.reason || '')}</p></div>`).join('') || '<p>尚未检测。点击上方按钮检查当前接口中的模型。</p>';
  if (!state.probing) $('visionProbeStatus').textContent = state.vision.checkedAt ? `检测时间：${new Date(state.vision.checkedAt).toLocaleString('zh-CN')}` : '';
}
async function probeAllVision() {
  if (state.busy || state.probing) return;
  state.probing = true; state.probeController = new AbortController(); updateControls();
  try {
    const response = await fetch(paperUrl('/api/vision/probe'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config.csrfToken }, body: '{}', signal: state.probeController.signal });
    await consumeStream(response, (event, data) => {
      if (event === 'probe_start') $('visionProbeStatus').textContent = `正在检测：0 / ${data.total}`;
      if (event === 'probe_result') { state.vision.models = [...state.vision.models.filter(item => item.model !== data.result.model), data.result]; state.vision.checkedAt = new Date().toISOString(); renderVisionResults(); $('visionProbeStatus').textContent = `正在检测：${data.completed} / ${data.total}`; renderVisionControls(); renderModels(); }
      if (event === 'probe_error') throw new Error(data.error);
      if (event === 'probe_done') toast(`检测完成：${data.supported} / ${data.total} 个模型通过图片识别。`);
    });
  } catch (error) { toast(error.name === 'AbortError' ? '视觉检测已停止。' : error.message); }
  finally { state.probing = false; state.probeController = null; await loadVision(); updateControls(); }
}

function sortedModels() {
  return [...state.models].sort((a, b) => Number(state.selected.has(b)) - Number(state.selected.has(a)) || a.localeCompare(b));
}
function renderModels() {
  $('selectedCount').textContent = `已选 ${state.selected.size} 个`;
  const query = $('modelSearch').value.trim().toLowerCase();
  const models = sortedModels().filter(model => model.toLowerCase().includes(query));
  $('modelList').innerHTML = models.length ? models.map(model => `<label class="model-item ${state.selected.has(model) ? 'selected' : ''}">${avatar(model)}<span class="model-info"><span class="model-name">${escapeHtml(model)}</span><span class="model-provider">${escapeHtml(vendor(model).name)} ${visionBadge(model)}</span></span><input type="checkbox" value="${escapeHtml(model)}" ${state.selected.has(model) ? 'checked' : ''} ${state.busy ? 'disabled' : ''} aria-label="选择 ${escapeHtml(model)}"></label>`).join('') : `<div class="${state.modelError ? 'model-error' : 'no-models'}">${escapeHtml(state.modelError || (query ? '没有匹配的模型' : '暂无模型，可手动添加模型 ID'))}</div>`;
  const previousReviewer = $('reviewerSelect').value;
  $('reviewerSelect').innerHTML = sortedModels().map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  if (state.models.includes(previousReviewer)) $('reviewerSelect').value = previousReviewer;
  else $('reviewerSelect').value = [...state.selected][0] || state.models[0] || '';
  renderVisionControls(); setSidebar(state.sidebarCollapsed, false); updateControls();
}

async function loadModels(refresh = false) {
  $('refreshModels').disabled = true;
  $('connectionStatus').className = 'connection';
  $('connectionStatus').lastElementChild.textContent = '正在连接接口';
  try {
    if (state.config?.managedConnection) {
      Object.assign(state.config, await api('/api/config'));
      $('settingsBtn').setAttribute('aria-label', 'ForX 账号与模型');
      $('settingsBtn').title = '在 ForX 中管理账号与模型接口';
    }
    const data = await api(`/api/models${refresh ? '?refresh=1' : ''}`);
    state.models = data.models.filter(model => !/image|embedding|rerank|whisper|tts|audio|video|dall-e/i.test(model));
    state.modelError = '';
    const existing = [...state.selected].filter(model => state.models.includes(model));
    if (existing.length) state.selected = new Set(existing);
    else {
      const preferred = ['k3', 'glm-5.3'].filter(model => state.models.includes(model));
      state.selected = new Set([...preferred, ...state.models.filter(model => !preferred.includes(model))].slice(0, 2));
      if (state.models.includes('glm-5.3')) $('reviewerSelect').value = 'glm-5.3';
    if (state.config.workspace) await PaperWorkspace.init();
    }
    $('connectionStatus').className = 'connection connected';
    $('connectionStatus').lastElementChild.textContent = state.config?.managedConnection ? 'ForX 已连接' : '已连接';
    $('connectionStatus').title = `${state.config?.connection?.account ? `当前账号：${state.config.connection.account} · ` : ''}${data.models.length} 个模型，已过滤 ${data.models.length - state.models.length} 个图片／音频等模型`;
  } catch (error) {
    state.modelError = error.message;
    $('connectionStatus').className = 'connection error';
    $('connectionStatus').lastElementChild.textContent = state.config?.keyConfigured ? '接口连接失败' : state.config?.managedConnection ? '请在 ForX 连接模型' : '待配置 API 密钥';
    $('connectionStatus').title = error.message;
  } finally { $('refreshModels').disabled = false; renderModels(); }
}

function updateControls() {
  $('askBtn').disabled = state.busy || state.probing || state.uploading || state.restoringCache || !activeDocument() || !state.selected.size || !state.config?.keyConfigured;
  $('askBtn').hidden = state.busy;
  $('cancelBtn').hidden = !state.busy;
  $('settingsBtn').disabled = state.busy || state.probing;
  if ($('historyBtn')) $('historyBtn').disabled = state.busy;
  $('question').disabled = state.busy;
  $('analyzeToggle').disabled = state.busy;
  $('reviewerSelect').disabled = state.busy || !$('analyzeToggle').checked;
  $('refreshModels').disabled = state.busy;
  ['temperature', 'maxTokens', 'contextBudget', 'analysisMaxTokens', 'analysisContextBudget'].forEach(id => { $(id).disabled = state.busy; });
  $('fullContextBtn').disabled = state.busy || !activeDocument();
  ['visualMode', 'visionReader', 'visualSelection', 'maxVisualPages', 'visualPages'].forEach(id => { $(id).disabled = state.busy; });
  $('visionProbeBtn').disabled = state.busy || state.probing || !state.config?.keyConfigured;
  $('stopVisionProbeBtn').hidden = !state.probing;
  $('exportBtn').disabled = state.busy || (state.config?.workspace ? !activeDocument() && !state.run : !state.run);
  $('retryAnalysisBtn').disabled = state.busy || !state.config?.keyConfigured || (state.run?.answers.filter(answer => answer.status === 'done').length || 0) < 2;
  $('uploadProgress').hidden = !state.uploading;
  $('dropzone').disabled = state.uploading;
  $('demoBtn').disabled = state.uploading;
  document.querySelectorAll('.quick-questions button').forEach(button => { button.disabled = state.busy; });
}

async function uploadFiles(files) {
  if (state.uploading) return;
  const selected = [...files];
  if (!selected.length) return;
  state.uploading = true; updateControls();
  try {
    for (const file of selected) {
      try {
        if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) throw new Error(`${file.name}：支持 PDF、DOCX、TXT、Markdown。`);
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name}：文件超过 50 MB。`);
        $('uploadProgress').lastElementChild.textContent = /\.pdf$/i.test(file.name) && state.config?.pdfParser?.provider === 'mineru' ? `MinerU 正在解析 ${file.name}，图表与公式识别可能需要数分钟…` : `正在提取：${file.name}`;
        const doc = await api('/api/documents', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: file });
        state.documents = [...state.documents.filter(item => item.id !== doc.id), doc]; state.activeDocumentId = doc.id; renderDocuments(); saveDraft();
        if (state.config?.workspace) await PaperWorkspace.library();
        toast(doc.reused ? `已打开本地保存的 ${doc.name}，无需重复解析。` : `已${doc.extraction?.provider === 'mineru' ? '通过 MinerU ' : ''}解析 ${doc.name}，提取 ${formatNumber(doc.chars)} 字符`);
      } catch (error) { toast(error.message); }
    }
  } finally { state.uploading = false; $('fileInput').value = ''; updateControls(); }
}

function renderMarkdown(text) { return PaperMarkdown.render(text); }

function metrics(answer) {
  const pieces = [];
  if (answer.elapsedMs) pieces.push(seconds(answer.elapsedMs));
  if (answer.usage?.total_tokens != null) pieces.push(`${formatNumber(answer.usage.total_tokens)} tokens`);
  else if (answer.usage?.completion_tokens != null) pieces.push(`${formatNumber(answer.usage.completion_tokens)} 输出 tokens`);
  else if (answer.status === 'done') pieces.push('用量未返回');
  if (answer.finishReason === 'length' && !['running','continuing'].includes(answer.status)) pieces.push('⚠ 输出截断');
  return pieces.join(' · ');
}

function renderRun() {
  const run = state.run; if (!run) return;
  $('emptyState').hidden = true; $('resultsSection').hidden = false;
  $('answersGrid').className = `answers-grid count-${run.answers.length}${state.view === 'list' ? ' list-view' : ''}`;
  $('answersGrid').innerHTML = run.answers.map((answer, index) => `<article class="answer-card" data-answer-index="${index}"><header class="answer-header">${avatar(answer.model)}<span class="model-info"><span class="model-name">${escapeHtml(answer.model)}</span><span class="model-provider">回答 ${String.fromCharCode(65 + index)}</span></span><span class="answer-state"></span></header><div class="answer-content markdown"></div><footer class="answer-footer"><span class="answer-metrics"></span><span class="answer-tools"><button data-copy-answer="${index}" title="复制回答" aria-label="复制 ${escapeHtml(answer.model)} 的回答">${icon('copy')}</button><button data-fullscreen-answer="${index}" title="全屏阅读" aria-label="全屏阅读 ${escapeHtml(answer.model)} 的回答">${icon('expand')}<span>阅读</span></button></span></footer></article>`).join('');
  renderVisualEvidence(); renderRunContent(); updateControls();
}

function renderVisualEvidence() {
  const visual = state.run?.visual;
  $('visualEvidence').hidden = !visual;
  if (!visual) return;
  const key = `${state.run.id}:${visual.mode}`;
  if ($('visualEvidence').dataset.structure !== key) {
    $('visualEvidence').dataset.structure = key;
    $('visualEvidence').innerHTML = `<div class="visual-evidence-heading"><strong id="visualStageStatus"></strong><span id="visualCacheStatus"></span><button id="fullscreenTranscript" class="button button-quiet button-small" type="button">全屏阅读</button></div><div class="visual-pages">${visual.pages.map(page => `<button class="source-ref" type="button" data-source-page="${page}">P${page}</button>`).join('')}</div><p>图片仅覆盖以上页面。共享转录可能有识别错误，可点击页码核对原图；完成的页面会保存在本机，后续只补读缺失页面。</p><details id="visualNotesDetails"><summary>图表与公式转录 · 生成时实时显示</summary><div id="visualTranscriptContent" class="markdown"></div></details>`;
    $('fullscreenTranscript').addEventListener('click', () => openReader('visual', null, true));
  }
  $('visualStageStatus').textContent = `${visual.status === 'done' ? '视觉证据已就绪' : visual.status === 'error' ? '视觉读取中断，完成页已保存' : visual.status === 'rendering' ? '正在准备页面图片' : '正在转录图表与公式'} · ${visual.status === 'done' ? visual.pages.length : visual.completed || 0} / ${visual.pages.length} 页`;
  const cached = visual.cachedPages?.length || Object.values(visual.pageDrafts || {}).filter(item => item.cached).length;
  $('visualCacheStatus').textContent = `${visual.reader || ''}${cached ? ` · 已复用 ${cached} 页缓存` : ''}${visual.usageTokens ? ` · 本轮 ${formatNumber(visual.usageTokens)} tokens` : ''}`;
  const text = visualText(visual);
  setRenderedContent($('visualTranscriptContent'), () => text ? renderMarkdown(text) : '<p class="muted">正在读取页面与缓存；模型返回的转录片段会立即显示。</p>', text);
}
function visualText(visual) {
  if (visual.notes && visual.status === 'done') return visual.notes;
  return (visual.pages || []).map(page => { const draft = visual.pageDrafts?.[page]; return draft ? `### [P${page}]${draft.cached ? ' · 已保存，直接复用' : draft.status === 'done' ? ' · 已完成并保存' : draft.reasoningChars ? ` · 正在思考（${formatNumber(draft.reasoningChars)} 字符）` : ' · 正在生成'}\n${draft.text || '等待转录正文…'}` : ''; }).filter(Boolean).join('\n\n');
}
function openReader(type, index = null, fullscreen = false) {
  state.reader = { type, index };
  $('answerDialog').classList.toggle('reader-fullscreen', fullscreen);
  $('readerSizeBtn').textContent = fullscreen ? '退出全屏' : '全屏阅读';
  renderReader(); if (!$('answerDialog').open) $('answerDialog').showModal();
}
function renderReader() {
  if (!state.reader || !state.run) return;
  const { type, index } = state.reader;
  const item = type === 'answer' ? state.run.answers[index] : type === 'analysis' ? state.run.analysis : state.run.visual;
  if (!item) return;
  const text = type === 'visual' ? visualText(item) : item.text || '';
  $('answerDialogTitle').textContent = type === 'visual' ? '图表与公式转录' : type === 'analysis' ? `对比分析 · ${item.model}` : item.model;
  $('answerDialogMeta').textContent = `${item.status === 'done' ? '已完成' : item.status === 'error' ? '生成失败' : item.status === 'incomplete' ? '待继续 · 已保存' : item.status === 'interrupted' ? '已中断 · 已保存' : item.status === 'cancelled' ? '已停止 · 已保存' : '正在生成 · 实时更新'}${type === 'visual' ? ` · ${item.reader || ''}` : ` · ${metrics(item)}`}`;
  const content = $('answerDialogContent'), nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 80;
  setRenderedContent(content, () => text ? renderMarkdown(text) : '<p class="muted">正在等待模型正文，收到内容后将在这里实时显示。</p>', `${type}:${index}:${text}`);
  if (nearBottom && state.busy) content.scrollTop = content.scrollHeight;
}

function renderRunContent() {
  const run = state.run; if (!run) return;
  const completed = run.answers.filter(answer => answer.status === 'done').length;
  $('resultCount').textContent = `${completed} / ${run.answers.length}`;
  const failed = run.answers.filter(answer => answer.status === 'error').length;
  $('runStatus').textContent = run.status === 'running'
    ? run.analysis.status === 'running' ? '回答已完成，正在分析共识与分歧…' : `正在并行生成 · ${completed} 个完成${failed ? `，${failed} 个失败` : ''}`
    : run.status === 'cancelled' ? '本轮已停止，已生成的内容仍可查看和导出'
    : run.status === 'error' ? '连接中断，已收到的回答已保留'
    : `${completed} 个模型回答完成${failed ? ` · ${failed} 个失败` : ''} · 总用时 ${seconds(run.elapsedMs)}`;
  if (run.context) {
    const context = run.context;
    $('contextNotice').className = `context-notice${context.mode === 'selected' ? ' partial' : ''}`;
    const kind = run.document.sourceType === 'page' ? '页' : '段';
    $('contextNotice').textContent = run.document.scanned ? '此 PDF 没有足够的可提取文字，本轮使用下方标明的视觉证据。' : context.mode === 'full'
      ? `本轮已提供全部提取的文字 · ${context.totalPages} ${kind} · ${formatNumber(context.chars)} 字符 · 所有模型使用相同原文与问题`
      : `本轮使用部分原文：${context.selectedPages.length} / ${context.totalPages} ${kind} · ${formatNumber(context.chars)} 字符${context.partialPage ? '（单页过长，仅提供部分文字）' : ''}。覆盖第 ${context.selectedPages.join('、')} ${kind}。未提供的内容无法据此核验。`;
  } else $('contextNotice').textContent = '正在准备相同的论文上下文…';
  run.answers.forEach((answer, index) => {
    const card = $('answersGrid').querySelector(`[data-answer-index="${index}"]`); if (!card) return;
    const status = card.querySelector('.answer-state');
    status.className = `answer-state ${answer.status}`;
    status.innerHTML = answer.status === 'done' ? `${icon('check')}完成` : answer.status === 'error' ? '失败' : answer.status === 'cancelled' ? '已停止' : `<span class="spinner"></span>${answer.reasoningChars && !answer.text ? '思考中' : '生成中'}`;
    const content = card.querySelector('.answer-content');
    const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 70;
    setRenderedContent(content, () => (answer.text ? renderMarkdown(answer.text) : answer.status === 'error' ? '' : `<div class="answer-placeholder">${answer.status === 'cancelled' ? '已停止，尚未收到回答。' : '<span class="spinner"></span>模型正在阅读论文…'}</div>`) + (answer.status === 'error' ? `<div class="answer-error">${escapeHtml(answer.error)}</div>` : ''), `${answer.status}:${answer.error || ''}:${answer.text}`);
    if (nearBottom && state.busy) content.scrollTop = content.scrollHeight;
    card.querySelector('.answer-metrics').textContent = [metrics(answer) || (answer.reasoningChars ? `已收到 ${formatNumber(answer.reasoningChars)} 个思考字符，等待正文` : answer.status === 'running' ? '等待首个回答片段' : '等待视觉证据'), answer.streaming === false ? '接口返回完整响应' : '', run.visual?.status === 'done' ? run.visual.mode === 'shared' ? '文字 + 共享视觉转录' : '文字 + 页面图片' : ''].filter(Boolean).join(' · ');
    card.querySelector('[data-copy-answer]').disabled = !answer.text;
    card.querySelector('[data-fullscreen-answer]').disabled = !answer.text;
  });
  const analysis = run.analysis;
  $('analysisPanel').hidden = analysis.status === 'off';
  $('analysisMeta').textContent = analysis.status === 'done' ? `${analysis.model} · ${seconds(analysis.elapsedMs)}${analysis.maxTokens ? ` · 输出预算 ${formatNumber(analysis.maxTokens)} tokens` : ''}${analysis.finishReason === 'length' ? ' · 输出已截断，可提高分析输出预算重试' : ''}`
    : analysis.status === 'running' ? `${analysis.model} 正在比较 ${completed} 份回答…`
    : analysis.status === 'error' ? '对比分析失败，模型回答仍可查看和导出'
    : analysis.status === 'skipped' ? '未生成分析'
    : analysis.status === 'cancelled' ? '分析已停止' : `将由 ${analysis.model} 在回答完成后进行分析`;
  setRenderedContent($('analysisContent'), () => analysis.text ? renderMarkdown(analysis.text) : analysis.status === 'error' ? `<div class="answer-error">${escapeHtml(analysis.error)}</div>`
    : analysis.status === 'skipped' ? `<p>${escapeHtml(analysis.reason)}</p>`
    : analysis.status === 'cancelled' ? '<p>已停止，可重新提问以生成完整分析。</p>'
    : '<div class="answer-placeholder"><span class="spinner"></span>等待模型回答，随后对照结论与证据。</div>', `${analysis.status}:${analysis.error || ''}:${analysis.reason || ''}:${analysis.text}`);
  $('copyAnalysis').disabled = !analysis.text;
  const evidence = analysis.context;
  $('analysisBudgetNotice').hidden = !evidence;
  if (evidence) $('analysisBudgetNotice').textContent = `分析原文：${evidence.mode === 'full' ? '全部提取文字' : '部分原文'}，${evidence.selectedPages.length}/${evidence.totalPages} 页或分段，${formatNumber(evidence.chars)} 字符 · 原文预算 ${formatNumber(evidence.budget)} · 加上回答与视觉转录共 ${formatNumber(analysis.inputChars)} 字符${analysis.usage?.prompt_tokens != null ? ` · 实际输入 ${formatNumber(analysis.usage.prompt_tokens)} tokens` : ''}${analysis.visualInput === 'text-only' && run.visual?.mode === 'direct' ? ' · 分析模型未收到页面图片，无法直接核验视觉内容' : ''}`;
  $('retryAnalysisBtn').querySelector('span').textContent = analysis.finishReason === 'length' ? '提高预算重试' : analysis.status === 'error' ? '重试分析' : '重新分析';
  if (analysis.status === 'running' && analysis.reasoningChars && !analysis.text) $('analysisMeta').textContent = `${analysis.model} 正在思考 · 已收到 ${formatNumber(analysis.reasoningChars)} 个思考字符，正文将流式显示`;
  renderVisualEvidence(); renderReader();
  if (state.config?.workspace) PaperWorkspace.render(run);
}
function scheduleRender() { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = null; renderRunContent(); }, 200); }

function applyEvent(event, data) {
  const run = state.run; if (!run) return;
  const answer = run.answers.find(item => item.model === data.model);
  if (event === 'start' && !data.analysisOnly) Object.assign(run, data);
  else if (event === 'model_start' && answer) answer.status = 'running';
  else if (event === 'model_delta' && answer) answer.text += data.delta;
  else if (event === 'model_progress' && answer) Object.assign(answer, data);
  else if (event === 'model_done' && answer) Object.assign(answer, data);
  else if (event === 'model_error' && answer) Object.assign(answer, data);
  else if (event === 'visual_start') { run.visual = { ...data, status: 'rendering', completed: 0, pageDrafts: {} }; renderVisualEvidence(); }
  else if (event === 'visual_render_progress') Object.assign(run.visual, data);
  else if (event === 'visual_progress') Object.assign(run.visual, data, { status: 'transcribing' });
  else if (event.startsWith('visual_page_')) {
    const visual = run.visual; visual.pageDrafts ||= {}; visual.status = 'transcribing';
    const draft = visual.pageDrafts[data.page] ||= { text: '', status: 'running' };
    if (event === 'visual_page_start') { draft.text = ''; draft.status = 'running'; }
    if (event === 'visual_page_delta') draft.text += data.delta;
    if (event === 'visual_page_done') Object.assign(draft, data, { status: 'done' });
    if (event === 'visual_page_reasoning' || event === 'visual_page_transport') Object.assign(draft, data);
  }
  else if (event === 'visual_done') { Object.assign(run.visual, data, { status: 'done' }); renderVisualEvidence(); }
  else if (event === 'run_error') { if (run.visual && run.visual.status !== 'done') run.visual.status = 'error'; throw new Error(data.error); }
  else if (event === 'analysis_start') Object.assign(run.analysis, data, { status: 'running' });
  else if (event === 'analysis_delta') run.analysis.text += data.delta;
  else if (event === 'analysis_progress') Object.assign(run.analysis, data);
  else if (event === 'analysis_done') Object.assign(run.analysis, data, { status: 'done' });
  else if (event === 'analysis_error') Object.assign(run.analysis, data, { status: 'error' });
  else if (event === 'analysis_skipped') Object.assign(run.analysis, data, { status: 'skipped' });
  else if (event === 'done') Object.assign(run, data, { status: 'done' });
  scheduleRender();
}

async function consumeStream(response, onEvent = applyEvent) {
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || '请求失败。'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const lines = block.split(/\r?\n/);
        const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (name && data) onEvent(name, JSON.parse(data));
      }
      if (done) break;
    }
    if (onEvent === applyEvent && state.run.status === 'running') throw new Error('服务连接中断，已收到的回答已保留。');
  } finally { reader.releaseLock(); }
}

async function askQuestion(event) {
  if (state.config?.workspace) return PaperWorkspace.ask(event);
  event.preventDefault();
    if (state.busy || state.probing) return;
  const doc = activeDocument(); const question = $('question').value.trim();
  if (!doc) return toast('请先上传论文。');
  if (!state.selected.size) return toast('请至少选择一个模型。');
  if (!question) return $('question').focus();
  const models = [...state.selected]; const analyze = $('analyzeToggle').checked;
  const reviewer = $('reviewerSelect').value || models[0];
  const options = { temperature: Number($('temperature').value), maxTokens: Number($('maxTokens').value), contextBudget: Number($('contextBudget').value), analysisMaxTokens: Number($('analysisMaxTokens').value), analysisContextBudget: Number($('analysisContextBudget').value), visualMode: doc.format === 'pdf' ? $('visualMode').value : 'off', visionReader: $('visionReader').value, visualSelection: $('visualSelection').value, maxVisualPages: Number($('maxVisualPages').value), visualPages: $('visualPages').value };
  saveDraft();
  state.run = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), document: { ...doc }, question, models, reviewer, options,
    status: 'running', answers: models.map(model => ({ model, status: 'waiting', text: '' })),
    analysis: { model: reviewer, status: analyze ? 'waiting' : 'off', text: '' } };
  state.busy = true; state.controller = new AbortController(); renderRun(); renderModels();
  const started = Date.now();
  try {
    const response = await fetch(paperUrl('/api/ask'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config.csrfToken },
      body: JSON.stringify({ documentId: doc.id, question, models, reviewer, analyze, options, visualEvidence: (() => {
        const previous = state.history.find(item => (item.document.id === doc.id || item.document.fingerprint && item.document.fingerprint === doc.fingerprint) && item.visual?.status === 'done' && item.visual.reader === options.visionReader);
        return previous?.visual ? { ...previous.visual, documentFingerprint: doc.fingerprint } : null;
      })() }), signal: state.controller.signal });
    await consumeStream(response);
    toast('本轮回答完成，报告可导出。');
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    state.run.status = cancelled ? 'cancelled' : 'error';
    for (const answer of state.run.answers) if (['waiting', 'running'].includes(answer.status)) {
      answer.status = cancelled ? 'cancelled' : 'error'; if (!cancelled) answer.error = error.message;
    }
    if (['waiting', 'running'].includes(state.run.analysis.status)) {
      state.run.analysis.status = cancelled ? 'cancelled' : 'error'; if (!cancelled) state.run.analysis.error = error.message;
    }
    toast(cancelled ? '已停止生成，已收到的回答已保留。' : error.message);
  } finally {
    state.run.elapsedMs ||= Date.now() - started;
    state.busy = false; state.controller = null;
    clearTimeout(renderTimer); renderTimer = null;
    renderRunContent(); renderModels(); updateControls(); saveHistory(state.run);
  }
}

async function retryAnalysis() {
  if (state.config?.workspace) return PaperWorkspace.retryAnalysis();
  if (state.busy || !state.run || state.run.answers.filter(answer => answer.status === 'done').length < 2) return;
  const run = state.run; const previousElapsed = run.elapsedMs || 0;
  const reviewer = $('reviewerSelect').value || run.reviewer;
  let analysisMaxTokens = Number($('analysisMaxTokens').value);
  if (run.analysis.finishReason === 'length') {
    const previous = run.analysis.maxTokens || run.options.analysisMaxTokens || run.options.maxTokens || 12000;
    if (analysisMaxTokens <= previous) analysisMaxTokens = Math.min(Number($('analysisMaxTokens').max), previous * 2);
    $('analysisMaxTokens').value = analysisMaxTokens;
  }
  const options = { ...run.options, analysisMaxTokens, analysisContextBudget: Number($('analysisContextBudget').value) };
  run.options = options; saveDraft();
  const started = Date.now();
  run.reviewer = reviewer; run.status = 'running'; run.analysis = { model: reviewer, status: 'running', text: '' };
  state.busy = true; state.controller = new AbortController(); renderRunContent(); renderModels(); updateControls();
  try {
    const response = await fetch(paperUrl('/api/ask'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.config.csrfToken },
      body: JSON.stringify({ documentId: run.document.id, question: run.question, models: run.models, reviewer, options, analyze: true, analysisOnly: true, answers: run.answers, visualEvidence: run.visual }), signal: state.controller.signal });
    await consumeStream(response);
    if (run.analysis.status === 'done') toast('已重新生成对比分析，没有重复请求各模型的回答。');
  } catch (error) {
    const cancelled = error.name === 'AbortError';
    run.status = cancelled ? 'cancelled' : 'done';
    run.analysis.status = cancelled ? 'cancelled' : 'error'; run.analysis.error = error.message;
    toast(cancelled ? '已停止分析，已有回答已保留。' : error.message);
  } finally {
    run.elapsedMs = previousElapsed + (Date.now() - started);
    state.busy = false; state.controller = null;
    clearTimeout(renderTimer); renderTimer = null;
    renderRunContent(); renderModels(); updateControls(); saveHistory(run);
  }
}

function loadHistory() {
  try { const data = JSON.parse(paperStorage().getItem(HISTORY_KEY) || '[]'); state.history = Array.isArray(data) ? data.filter(run => run && run.id && run.document && Array.isArray(run.answers) && run.analysis).slice(0, 30) : []; }
  catch { state.history = []; }
  $('historyCount').textContent = state.history.length;
}
function persistHistory() {
  while (state.history.length) {
    try { paperStorage().setItem(HISTORY_KEY, JSON.stringify(state.history)); break; }
    catch { if (state.history.length === 1) { toast('浏览器存储空间不足，请导出本轮报告保存。'); break; } state.history.pop(); }
  }
  if (!state.history.length) paperStorage().removeItem(HISTORY_KEY);
  $('historyCount').textContent = state.history.length;
}
function saveHistory(run) {
  state.history = [JSON.parse(JSON.stringify(run)), ...state.history.filter(item => item.id !== run.id)].slice(0, 30);
  persistHistory();
}
function renderHistory() {
  $('historyList').innerHTML = state.history.length ? state.history.map(run => `<div class="history-row"><button class="history-open" data-open-history="${escapeHtml(run.id)}"><strong>${escapeHtml(run.question)}</strong><span>${escapeHtml(run.document.name)} · ${run.answers.filter(answer => answer.status === 'done').length}/${run.answers.length} 个回答 · ${escapeHtml(new Date(run.startedAt).toLocaleString('zh-CN'))}</span></button><button class="icon-button" data-delete-history="${escapeHtml(run.id)}" aria-label="删除本轮历史">${icon('close')}</button></div>`).join('') : '<div class="no-models">还没有问答记录，完成一次提问后会保存在这里。</div>';
}
async function restoreHistoricalTranscripts() {
  let count = 0;
  for (const run of state.history) {
    if (run.visual?.mode !== 'shared' || run.visual.status !== 'done' || !run.visual.notes || !state.documents.some(doc => doc.id === run.document.id || doc.fingerprint && doc.fingerprint === run.document.fingerprint)) continue;
    try { const result = await api('/api/visual-cache/import', { method: 'POST', json: { items: [{ documentId: run.document.id, fingerprint: run.document.fingerprint, extractionVersion: run.document.extractionVersion || 1, visual: run.visual }] } }); count += result.importedPages; }
    catch { /* Legacy histories remain readable when their transcript cannot be imported. */ }
  }
  if (count) toast(`已从历史记录恢复 ${count} 页视觉转录缓存。`);
}

async function openSource(number = 1, documentId = state.activeDocumentId, kind = null, paragraph = null, extractionVersion = null) {
  if (!documentId) return toast('请先上传论文。');
  const request = state.sourceRequest = (state.sourceRequest || 0) + 1;
  try {
    const doc = await api(`/api/documents/${documentId}${extractionVersion ? `?extractionVersion=${extractionVersion}` : ''}`);
    if (request !== state.sourceRequest) return;
    if (kind && kind !== (doc.sourceType === 'page' ? 'P' : 'S')) return toast('引用类型与原文不一致，可能是模型自行编造的分段标记，请核验回答。');
    state.sourceDocument = doc;
    $('sourceTitle').textContent = doc.name;
    $('sourceMeta').textContent = `${doc.sourceType === 'page' ? '按原始 PDF 页码排列' : '文本按分段排列'} · ${doc.visualAvailable ? '原始页面保留图表、公式和排版，可与提取文字对照' : doc.format === 'pdf' ? '原始 PDF 尚未保留，请重新上传以查看图片' : '文本分段预览'}`;
    if (paragraph && !doc.pages[number - 1]?.paragraphs?.some(part => part.number === Number(paragraph))) return toast('引用的段落在提取原文中不存在，请核验模型的引用。');
    state.sourceParagraph = paragraph ? Number(paragraph) : null;
    state.sourceView = paragraph || !doc.visualAvailable ? 'text' : 'image';
    $('sourcePageSelect').innerHTML = doc.pages.map(page => `<option value="${page.number}">第 ${page.number} ${doc.sourceType === 'page' ? '页' : '段'}</option>`).join('');
    if (number > doc.pages.length) toast('该引用超出原文范围，请核验模型是否生成了错误引用。');
    $('sourcePageSelect').value = Math.min(Math.max(1, Number(number)), doc.pages.length);
    $('sourceCoverage').textContent = `共 ${doc.pages.length} ${doc.sourceType === 'page' ? '页' : '段'} · ${formatNumber(doc.chars)} 字符 · ${doc.extraction?.provider === 'mineru' ? 'MinerU' : 'Poppler'} v${doc.extractionVersion || 1}${doc.currentExtractionVersion > (doc.extractionVersion || 1) ? ' · 历史问答原文' : ''}`;
    renderSourcePage(); if (!$('sourceDialog').open) { if (state.config?.workspace && innerWidth >= 1000) { $('sourceDialog').show(); document.body.classList.add('source-open'); } else $('sourceDialog').showModal(); }
  } catch (error) { if (request === state.sourceRequest) toast(`${error.message} 历史中的回答仍可查看和导出。`); }
}
function renderSourcePage() {
  const page = state.sourceDocument?.pages.find(item => item.number === Number($('sourcePageSelect').value));
  const imageView = state.sourceView === 'image' && state.sourceDocument?.visualAvailable;
  const paragraphs = page?.paragraphs || [];
  $('sourceParagraphSelect').innerHTML = '<option value="">整页</option>' + paragraphs.map(part => `<option value="${part.number}">第 ${part.number} 段 · ${escapeHtml(part.text.replace(/\s+/g, ' ').slice(0, 38))}</option>`).join('');
  $('sourceParagraphSelect').value = state.sourceParagraph || '';
  if ($('sourcePrev')) $('sourcePrev').disabled = $('sourcePageSelect').selectedIndex <= 0;
  if ($('sourceNext')) $('sourceNext').disabled = $('sourcePageSelect').selectedIndex >= $('sourcePageSelect').options.length - 1;
  const structured = state.sourceDocument?.extraction?.provider === 'mineru';
  $('sourceText').innerHTML = paragraphs.length ? paragraphs.map(part => `<section class="source-paragraph ${part.number === state.sourceParagraph ? 'highlighted' : ''}" data-paragraph-number="${part.number}"><span class="paragraph-label">${escapeHtml(part.id)}</span><div${structured ? ' class="markdown"' : ''}>${structured ? renderMarkdown(part.text) : escapeHtml(part.text)}</div></section>`).join('') : escapeHtml(page?.text || '这一页没有可提取的文字。');
  $('sourceText').scrollTop = 0;
  $('sourceText').hidden = imageView; $('sourceImageWrap').hidden = !imageView;
  $('sourceImageBtn').disabled = !state.sourceDocument?.visualAvailable;
  $('sourceUsePageBtn').disabled = !state.sourceDocument?.visualAvailable || state.busy;
  $('sourceZoomBtn').hidden = !imageView;
  $('sourceImageBtn').classList.toggle('active', imageView); $('sourceTextBtn').classList.toggle('active', !imageView);
  $('sourceImageWrap').classList.remove('zoomed'); $('sourceZoomBtn').setAttribute('aria-label', '放大原图'); $('sourceZoomBtn').title = '放大原图';
  if (imageView && page) { $('sourceImageStatus').hidden = false; $('sourceImageStatus').textContent = '正在渲染页面…'; $('sourceImage').hidden = true; $('sourceImage').alt = `论文原始第 ${page.number} 页`; $('sourceImage').src = paperUrl(`/api/documents/${state.sourceDocument.id}/pages/${page.number}/image?extractionVersion=${state.sourceDocument.extractionVersion || 1}`); }
  if (state.sourceParagraph && !imageView) requestAnimationFrame(() => {
    const panel = $('sourceText'), selected = panel.querySelector('.highlighted');
    if (selected) panel.scrollTop = Math.max(0, panel.scrollTop + selected.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 3);
  });
}

async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板。'); } catch { toast('无法访问剪贴板，请展开回答后手动复制。'); } }

function reportMarkdown(run) {
  const status = value => ({ done: '完成', running: '生成中', waiting: '等待', continuing: '续写中', interrupted: '已中断', incomplete: '待继续', cancelled: '已停止', error: '失败', off: '未启用', skipped: '未运行' }[value] || value);
  const lines = ['# 论文多模型问答对比报告', '', `- 文件：${run.document.name}`, `- 原文提取版本：v${run.document.extractionVersion || 1}（${run.document.extraction?.provider || "poppler"}）`, `- 时间：${new Date(run.startedAt).toLocaleString('zh-CN')}`, `- 状态：${status(run.status)}`, `- 模型：${run.models.join('、')}`, `- 分析模型：${run.analysis.status === 'off' ? '本轮未启用' : run.analysis.model || run.reviewer}`, `- 总用时：${seconds(run.elapsedMs)}`,
    `- 参数：温度 ${run.options.temperature}；回答最大输出 ${run.options.maxTokens} tokens；回答原文预算 ${run.options.contextBudget} 字符${run.analysis.status === 'off' ? '' : `；分析最大输出 ${run.options.analysisMaxTokens || run.analysis.maxTokens || '旧版共用'} tokens；分析原文预算 ${run.options.analysisContextBudget || '旧版共用'} 字符`}`, ''];
  if (run.context) lines.push(`- 原文覆盖：${run.context.mode === 'full' ? '全部提取的文字' : '部分原文'}，${run.context.selectedPages.length}/${run.context.totalPages} 页或分段，${run.context.chars} 字符${run.context.partialPage ? '（单页仅提供部分文字）' : ''}`, `- 已提供页码／分段：${run.context.selectedPages.join('、')}`, '');
  if (run.visual) lines.push(`- 视觉方式：${run.visual.mode === 'shared' ? `共享视觉转录，由 ${run.visual.reader} 读取` : '直接输入原始页面图片'}`, `- 图片覆盖：${run.visual.pages.join('、')}，共 ${run.visual.pages.length}/${run.visual.totalPages} 页；状态 ${run.visual.status}`, `- 分析模型视觉输入：${run.analysis.visualInput || '未运行'}`, '');
  lines.push('## 问题', '', run.question, '');
  if (run.visual?.notes) lines.push('## 共享视觉转录', '', '以下内容由视觉模型转录，可能有识别错误，关键数值与公式需核对原图。', '', run.visual.notes, '');
  for (const [index, answer] of run.answers.entries()) {
    lines.push(`## 回答 ${String.fromCharCode(65 + index)}：${answer.model}`, '', `状态：${status(answer.status)} · ${metrics(answer)}`, '');
    if (answer.segments?.length) lines.push(`生成调用：${answer.segments.length} 次；版本：${answer.version || 1}`, '');
    if (answer.usage) lines.push(`用量：输入 ${answer.usage.prompt_tokens ?? '未返回'} tokens，输出 ${answer.usage.completion_tokens ?? '未返回'} tokens，总计 ${answer.usage.total_tokens ?? '未返回'} tokens`, '');
    if (answer.firstTokenMs != null) lines.push(`首个回答片段：${seconds(answer.firstTokenMs)}`, '');
    lines.push(answer.text || '未收到回答。', ''); if (answer.error) lines.push(`错误：${answer.error}`, '');
  }
  if (run.analysis.status !== 'off') {
    lines.push('## 对比分析', '', `分析模型：${run.analysis.model} · 状态：${run.analysis.status}`, '', run.analysis.text || run.analysis.reason || run.analysis.error || '未生成分析。', '');
    if (run.analysis.context) lines.push(`分析原文范围：${run.analysis.context.mode === 'full' ? '全部提取文字' : '部分原文'}，${run.analysis.context.selectedPages.length}/${run.analysis.context.totalPages} 页或分段；原文预算 ${run.analysis.context.budget} 字符；输出预算 ${run.analysis.maxTokens} tokens。`, '');
    if (run.analysis.finishReason === 'length') lines.push('注意：分析输出已被截断。', '');
  }
  lines.push('---', '分析由模型生成，关键结论请结合原文核验。图片仅覆盖报告中标明的页面，视觉转录可能有识别错误；P 为原始页码，S 为提取文本的分段编号。');
  return lines.join('\n');
}
async function reportHtml(run, markdown = reportMarkdown(run)) {
  let css = await (await fetch(paperUrl('/vendor/katex/katex.min.css'))).text();
  const fonts = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)\s*format\(["']?woff2["']?\)/g)].map(match => match[1].replace(/["']/g, '')))];
  const embedded = new Map(await Promise.all(fonts.map(async font => {
    const response = await fetch(paperUrl(`/vendor/katex/${font}`));
    if (!response.ok) throw new Error('公式字体加载失败，请重试导出。');
    const bytes = new Uint8Array(await response.arrayBuffer()); let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return [font, `data:font/woff2;base64,${btoa(binary)}`];
  })));
  css = css.replace(/src:([^;]+);/g, (_, sources) => {
    const font = /url\(([^)]+\.woff2)\)/.exec(sources)?.[1]?.replace(/["']/g, '');
    return font && embedded.has(font) ? `src:url("${embedded.get(font)}") format("woff2");` : '';
  });
  const content = renderMarkdown(markdown).replace(/<button([^>]*)class="source-ref"[^>]*>(.*?)<\/button>/g, '<span class="source-ref">$2</span>');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'"><title>${escapeHtml(run.document.name)} · 论文对比报告</title><style>${css}\nbody{margin:0;background:#f7f8f4;color:#28372e;font:15px/1.8 system-ui,sans-serif}main{max-width:1000px;margin:30px auto;padding:36px;background:#fff;border-radius:12px}h1,h2,h3{line-height:1.4}h2{margin-top:2em;border-top:1px solid #e5e9e1;padding-top:1em}p,li{overflow-wrap:anywhere}.table-scroll,.math-block{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e1e5db;padding:9px;text-align:left}pre{overflow:auto;background:#f5f6f1;padding:15px}code{font-family:monospace}.source-ref{color:#36775b;font-size:12px}.math-fallback{white-space:pre-wrap;color:#9a622d}.katex-display{margin:1em 0}@media(max-width:600px){main{margin:0;padding:18px}}</style></head><body><main class="markdown">${content}</main></body></html>`;
}
async function downloadReport(format) {
  if (state.config?.workspace) return PaperWorkspace.exportReport(format).catch(error => toast(error.message));
  if (!state.run) return;
  let text;
  try { text = format === 'json' ? JSON.stringify(state.run, null, 2) : format === 'html' ? await reportHtml(state.run) : reportMarkdown(state.run); }
  catch (error) { toast(error.message); return; }
  const blob = new Blob([text], { type: format === 'json' ? 'application/json;charset=utf-8' : format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${state.run.document.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')}-对比报告.${format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'}`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('exportDialog').close(); toast('报告已导出。');
}

function bindEvents() {
  $('sidebarToggle').addEventListener('click', () => setSidebar(!state.sidebarCollapsed));
  $('readerSizeBtn').addEventListener('click', () => { const full = $('answerDialog').classList.toggle('reader-fullscreen'); $('readerSizeBtn').textContent = full ? '退出全屏' : '全屏阅读'; });
  $('readerCopyBtn').addEventListener('click', () => { const reader = state.reader; if (!reader || !state.run) return; copyText(reader.type === 'visual' ? visualText(state.run.visual) : reader.type === 'analysis' ? state.run.analysis.text : state.run.answers[reader.index].text); });
  $('answerDialog').addEventListener('close', () => { state.reader = null; $('answerDialog').classList.remove('reader-fullscreen'); });
  $('fullscreenAnalysis').addEventListener('click', () => openReader('analysis', null, true));
  $('dropzone').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => uploadFiles(event.target.files));
  ['dragenter', 'dragover'].forEach(name => $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(name => $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); }));
  $('dropzone').addEventListener('drop', event => uploadFiles(event.dataTransfer.files));
  $('demoBtn').addEventListener('click', async () => {
    try { const doc = await api('/api/demo', { method: 'POST' }); state.documents.push(doc); state.activeDocumentId = doc.id; renderDocuments(); toast('已载入测试文档。其中的研究与数据均为虚构示例。'); }
    catch (error) { toast(error.message); }
  });
  $('documentList').addEventListener('click', async event => {
    const remove = event.target.closest('[data-delete-document]');
    if (remove) {
      if (state.config?.workspace && !PaperWorkspace.confirmDelete()) return;
      try {
        const id = remove.dataset.deleteDocument; await api(`/api/documents/${id}`, { method: 'DELETE' });
        state.documents = state.documents.filter(doc => doc.id !== id);
        if (state.activeDocumentId === id) state.activeDocumentId = state.documents[0]?.id || null;
        renderDocuments();
      } catch (error) { toast(error.message); }
      return;
    }
    if (event.target.closest('.action-menu')) return;
    const row = event.target.closest('[data-document]'); if (row) { state.activeDocumentId = row.dataset.document; renderDocuments(); saveDraft(); }
  });
  $('documentList').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-document]')) { event.preventDefault(); event.target.click(); } });
  $('sourceBtn').addEventListener('click', () => $('sourceDialog').open ? $('sourceDialog').close() : openSource());
  $('sourcePageSelect').addEventListener('change', () => { state.sourceParagraph = null; renderSourcePage(); });
  $('sourceParagraphSelect').addEventListener('change', () => { state.sourceParagraph = Number($('sourceParagraphSelect').value) || null; renderSourcePage(); });
  $('sourceImageBtn').addEventListener('click', () => { state.sourceView = 'image'; renderSourcePage(); });
  $('sourceTextBtn').addEventListener('click', () => { state.sourceView = 'text'; renderSourcePage(); });
  $('sourceImage').addEventListener('load', () => { $('sourceImageStatus').hidden = true; $('sourceImage').hidden = false; });
  $('sourceImage').addEventListener('error', () => { $('sourceImageStatus').hidden = false; $('sourceImageStatus').textContent = '页面图片加载失败，可切换到提取文字，或重新上传 PDF。'; });
  $('sourceZoomBtn').addEventListener('click', () => { const zoomed = $('sourceImageWrap').classList.toggle('zoomed'); $('sourceZoomBtn').setAttribute('aria-label', zoomed ? '适应宽度' : '放大原图'); $('sourceZoomBtn').title = zoomed ? '适应宽度' : '放大原图'; });
  $('sourceUsePageBtn').addEventListener('click', () => {
    if (state.busy || !state.sourceDocument?.visualAvailable) return;
    state.activeDocumentId = state.sourceDocument.id;
    const number = $('sourcePageSelect').value;
    $('visualPages').value = $('visualSelection').value === 'manual' && $('visualPages').value.trim() ? `${$('visualPages').value},${number}` : number;
    $('visualSelection').value = 'manual'; if ($('visualMode').value === 'off') $('visualMode').value = 'shared';
    renderDocuments(); saveDraft(); if (state.config?.workspace) PaperWorkspace.showComposer(); else $('sourceDialog').close(); toast(`已将第 ${number} 页加入图片输入。`);
  });
  $('visionResultsBtn').addEventListener('click', () => { renderVisionResults(); $('visionDialog').showModal(); });
  $('visionProbeBtn').addEventListener('click', probeAllVision);
  $('stopVisionProbeBtn').addEventListener('click', () => state.probeController?.abort());
  ['visualMode', 'visionReader', 'visualSelection'].forEach(id => $(id).addEventListener('change', () => { renderVisionControls(); saveDraft(); }));
  ['visualPages', 'maxVisualPages'].forEach(id => $(id).addEventListener('input', saveDraft));
  $('modelSearch').addEventListener('input', renderModels);
  $('modelList').addEventListener('change', event => {
    if (!event.target.matches('input[type=checkbox]')) return;
    const model = event.target.value;
    if (event.target.checked && state.selected.size >= 6) { event.target.checked = false; return toast('最多同时选择 6 个模型。'); }
    if (event.target.checked) state.selected.add(model); else state.selected.delete(model);
    renderModels(); saveDraft();
  });
  $('refreshModels').addEventListener('click', () => loadModels(true));
  $('reviewerSelect').addEventListener('change', saveDraft);
  const addModel = () => {
    if (state.busy) return toast('请等待本轮回答完成。');
    const model = $('manualModelInput').value.trim(); if (!model || model.length > 200) return toast('请输入有效的模型 ID（最多 200 字符）。');
    if (!state.models.includes(model)) state.models.push(model);
    if (state.selected.size < 6) state.selected.add(model);
    $('manualModelInput').value = ''; state.modelError = ''; renderModels(); saveDraft();
  };
  $('addModelBtn').addEventListener('click', addModel);
  $('manualModelInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } });
  $('analyzeToggle').addEventListener('change', updateControls);
  ['question', 'temperature', 'maxTokens', 'contextBudget', 'analysisMaxTokens', 'analysisContextBudget'].forEach(id => $(id).addEventListener('input', () => { contextBudgetHint(); saveDraft(); }));
  $('fullContextBtn').addEventListener('click', () => {
    const doc = activeDocument(); if (!doc) return;
    const required = doc.contextChars || doc.chars + doc.pages * 20;
    const cap = Number($('contextBudget').max);
    if (required > cap) return toast(`全文需要 ${formatNumber(required)} 字符，超过 ${formatNumber(cap)} 的上限。请拆分文档，或选取相关页面。`);
    $('contextBudget').value = Math.max(4000, Math.ceil(required / 1000) * 1000);
    contextBudgetHint(); saveDraft(); toast('已填入覆盖全部提取文字的预算，实际模型上下文容量由接口决定。');
  });
  document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { $('question').value = button.dataset.question; $('question').focus(); }));
  $('questionForm').addEventListener('submit', askQuestion);
  $('question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('questionForm').requestSubmit(); } });
  $('cancelBtn').addEventListener('click', () => state.config?.workspace ? PaperWorkspace.cancel() : state.controller?.abort());
  $('settingsBtn').addEventListener('click', () => {
    if (state.config?.managedConnection) {
      if (window.parent !== window) window.parent.postMessage({ type: 'paper-compare:open-provider-settings' }, '*');
      else toast('请回到 ForX，在设置 → 账号与模型中管理登录和接口。');
      return;
    }
    $('baseUrlInput').value = state.config?.baseUrl || ''; $('apiKeyInput').value = '';
    $('apiKeyInput').placeholder = state.config?.keyConfigured ? '已配置，留空保留现有密钥' : '填写 API 密钥';
    if ($('pdfParserStatus')) {
      const parser = state.config?.pdfParser;
      $('pdfParserStatus').textContent = parser?.provider === 'mineru' ? `PDF 解析：MinerU · ${parser.tier} · ${parser.baseUrl}。原文件与解析结果保存在本机；图中内容仍可继续核对原图。` : 'PDF 解析：Poppler 本地文字提取。';
    }
    $('settingsStatus').textContent = ''; $('settingsDialog').showModal();
  });
  $('settingsForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const saved = await api('/api/config', { method: 'POST', json: { baseUrl: $('baseUrlInput').value, apiKey: $('apiKeyInput').value } });
      Object.assign(state.config, saved); $('apiKeyInput').value = ''; await loadModels(true); await loadVision();
      if (state.modelError) $('settingsStatus').textContent = state.modelError;
      else { $('settingsDialog').close(); toast('接口配置已保存，模型列表已更新。'); }
    } catch (error) { $('settingsStatus').textContent = error.message; }
    finally { button.disabled = false; updateControls(); }
  });
  $('historyBtn')?.addEventListener('click', () => { if (state.config?.workspace) return PaperWorkspace.history().catch(error => toast(error.message)); renderHistory(); $('historyDialog').showModal(); });
  $('historyList').addEventListener('click', event => {
    const open = event.target.closest('[data-open-history]');
    if (open) {
      const run = state.history.find(item => item.id === open.dataset.openHistory);
      if (run) { state.run = JSON.parse(JSON.stringify(run)); $('question').value = run.question;
        if (state.documents.some(doc => doc.id === run.document.id)) { state.activeDocumentId = run.document.id; renderDocuments(); }
        renderRun(); saveDraft(); $('historyDialog').close(); }
      return;
    }
    const remove = event.target.closest('[data-delete-history]');
    if (remove) { state.history = state.history.filter(run => run.id !== remove.dataset.deleteHistory); persistHistory(); renderHistory(); }
  });
  $('clearHistoryBtn').addEventListener('click', () => { state.history = []; persistHistory(); renderHistory(); toast('浏览器中的问答历史已清空。'); });
  $('gridViewBtn').addEventListener('click', () => setView('grid'));
  $('listViewBtn').addEventListener('click', () => setView('list'));
  $('answersGrid').addEventListener('click', event => {
    const copy = event.target.closest('[data-copy-answer]'); if (copy) return copyText(state.run.answers[Number(copy.dataset.copyAnswer)].text);
    const full = event.target.closest('[data-fullscreen-answer]'); if (full) openReader('answer', Number(full.dataset.fullscreenAnswer), true);
  });
  document.addEventListener('click', event => {
    const citation = event.target.closest('[data-source-page]'); if (citation) {
      const context = citation.closest('[data-extraction-version]');
      const source = citation.closest('#sourceText') ? state.sourceDocument : state.run?.document;
      openSource(Number(citation.dataset.sourcePage), context?.dataset.documentId || source?.id || state.activeDocumentId, citation.dataset.sourceKind || null, citation.dataset.sourceParagraph || null, Number(context?.dataset.extractionVersion) || source?.extractionVersion || 1);
    }
    const close = event.target.closest('[data-close]'); if (close) $(close.dataset.close).close();
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
  $('copyAnalysis').addEventListener('click', () => copyText(state.run?.analysis.text || ''));
  $('retryAnalysisBtn').addEventListener('click', retryAnalysis);
  $('exportBtn').addEventListener('click', () => { if (state.config?.workspace) { $('exportScope').querySelector('[value=turn]').disabled = !state.run; $('exportScope').querySelector('[value=conversation]').disabled = !PaperWorkspace.context().conversation; if (!state.run) $('exportScope').value = 'notes'; } $('exportDialog').showModal(); });
  $('exportMarkdownBtn').addEventListener('click', () => downloadReport('md'));
  $('exportJsonBtn').addEventListener('click', () => downloadReport('json'));
  $('exportHtmlBtn').addEventListener('click', () => downloadReport('html'));
  window.addEventListener('beforeunload', event => { if (state.busy && !state.config?.workspace) { event.preventDefault(); event.returnValue = ''; } });
}

function setView(view) {
  state.view = view; $('answersGrid').classList.toggle('list-view', view === 'list');
  $('gridViewBtn').classList.toggle('active', view === 'grid'); $('gridViewBtn').setAttribute('aria-pressed', view === 'grid');
  $('listViewBtn').classList.toggle('active', view === 'list'); $('listViewBtn').setAttribute('aria-pressed', view === 'list');
}

async function init() {
  bindEvents(); loadHistory(); updateControls();
  try { setSidebar(paperStorage().getItem('paper-compare-sidebar-collapsed') === 'true', false); } catch {}
  try {
    state.config = await api('/api/config');
    $('contextBudget').max = state.config.maxContextBudget || 120000;
    $('maxTokens').max = state.config.maxOutputTokens || 12000;
    $('analysisMaxTokens').max = state.config.maxAnalysisTokens || 32768;
    if (!state.config.maxContextBudget) { $('contextBudget').value = 120000; toast('服务正在更新输入预算；当前后端仍支持最多 120,000 字符。'); }
    const data = await api('/api/documents'); state.documents = data.documents;
    let draft = null; try { draft = JSON.parse(paperStorage('session').getItem(DRAFT_KEY) || 'null'); } catch {}
    state.activeDocumentId = state.documents.find(doc => doc.id === draft?.documentId)?.id || state.documents.at(-1)?.id || null;
    if (draft) {
      $('question').value = typeof draft.question === 'string' ? draft.question : '';
      for (const id of ['temperature', 'maxTokens', 'contextBudget', 'analysisMaxTokens', 'analysisContextBudget']) if (draft[id] !== undefined && Number.isFinite(Number(draft[id]))) $(id).value = Math.max(Number($(id).min), Math.min(Number($(id).max), Number(draft[id])));
    }
    renderDocuments();
    await loadModels();
    if (Array.isArray(draft?.selectedModels)) {
      const selected = draft.selectedModels.filter(model => typeof model === 'string' && model.trim() && model.length <= 200 && !/[\r\n]/.test(model) && (state.models.includes(model) || state.modelError)).slice(0, 6);
      if (selected.length) { state.models = [...new Set([...state.models, ...selected])]; state.selected = new Set(selected); renderModels(); }
    }
    await loadVision();
    await restoreHistoricalTranscripts();
    if (draft) {
      for (const id of ['visualMode', 'visualSelection', 'visionReader']) if (typeof draft[id] === 'string' && [...$(id).options].some(option => option.value === draft[id])) $(id).value = draft[id];
      if (typeof draft.visualPages === 'string') $('visualPages').value = draft.visualPages.slice(0, 240);
      if (Number.isFinite(Number(draft.maxVisualPages))) $('maxVisualPages').value = Math.max(1, Math.min(40, Number(draft.maxVisualPages)));
      renderVisionControls();
    }
    if (draft?.reviewer && state.models.includes(draft.reviewer)) $('reviewerSelect').value = draft.reviewer;
    else if (state.models.includes('glm-5.3')) $('reviewerSelect').value = 'glm-5.3';
    if (state.config.workspace) await PaperWorkspace.init();
  } catch (error) { toast(`本地服务连接失败：${error.message}`); $('connectionStatus').className = 'connection error'; $('connectionStatus').lastElementChild.textContent = '本地服务连接失败'; }
  finally { state.restoringCache = false; updateControls(); }
}
init();
