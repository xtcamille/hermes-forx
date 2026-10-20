import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_MINERU_URL = 'http://127.0.0.1:8000/v1';
const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'partial', 'failed', 'canceled', 'cancelled']);
const STATES = new Set(['queued', 'running', ...TERMINAL]);
const fault = (message, status = 502) => Object.assign(new Error(message), { status });

export function normalizeMineruUrl(value = DEFAULT_MINERU_URL) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('MinerU 地址需为不含密钥和查询参数的 HTTP(S) 地址。', 400);
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1\/(?:health|parse\/jobs)$/, '/v1');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.href.replace(/\/$/, '');
}

export function pdfParserSettings(input = {}) {
  const provider = input.provider ?? process.env.PDF_PARSER ?? 'mineru';
  if (!['mineru', 'poppler'].includes(provider)) throw fault('PDF_PARSER 仅支持 mineru 或 poppler。', 400);
  const tier = input.tier ?? process.env.MINERU_TIER ?? 'standard';
  if (!['flash', 'basic', 'standard', 'advanced'].includes(tier)) throw fault('MinerU 档位需为 flash、basic、standard 或 advanced。', 400);
  const apiKey = String(input.apiKey ?? process.env.MINERU_API_KEY ?? '').trim();
  if (apiKey.length > 2048 || /[\r\n]/.test(apiKey)) throw fault('MinerU 密钥格式无效。', 400);
  const timeoutMs = Number(input.timeoutMs ?? process.env.MINERU_TIMEOUT_MS ?? 900_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw fault('MinerU 超时需为 100–3600000 毫秒。', 400);
  return { provider, baseUrl: normalizeMineruUrl(input.baseUrl ?? process.env.MINERU_BASE_URL ?? DEFAULT_MINERU_URL), tier, apiKey, timeoutMs, pollIntervalMs: Math.max(10, Number(input.pollIntervalMs) || 1500) };
}

export function publicParserSettings(settings) {
  return { provider: settings.provider, baseUrl: settings.provider === 'mineru' ? settings.baseUrl : undefined, tier: settings.provider === 'mineru' ? settings.tier : undefined, keyConfigured: !!settings.apiKey };
}

function safeMessage(error, settings) {
  let text = String(error?.message || error);
  if (settings.apiKey) text = text.split(settings.apiKey).join('[已隐藏]');
  return text.replace(/\bsk-[\w-]{8,}/g, '[已隐藏]').slice(0, 800);
}

async function readLimited(response, limit = MAX_ARTIFACT_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); throw fault('MinerU 返回的解析产物过大，请拆分 PDF 后重试。'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw fault('MinerU 返回的解析产物过大，请拆分 PDF 后重试。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function transport(settings, signal) {
  const base = new URL(settings.baseUrl + '/');
  const resolve = path => new URL(path, base);
  const headers = url => url.origin === base.origin && settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
  async function request(path, options = {}) {
    const url = resolve(path);
    if (url.origin !== base.origin) throw fault('MinerU 返回了其他服务的任务地址，已停止读取。');
    const response = await fetch(url, { ...options, headers: { ...headers(url), ...options.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'manual' });
    const bytes = await readLimited(response);
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch { throw fault(`MinerU 返回了无效 JSON（HTTP ${response.status}）。`); }
    if (!response.ok) throw fault(`MinerU 请求失败（HTTP ${response.status}）：${String(data.error?.message || data.detail || data.message || '请检查服务日志。')}`, response.status === 401 || response.status === 403 ? 503 : 502);
    return data;
  }
  async function artifact(file) {
    if (!file || typeof file.file_id !== 'string' || !file.file_id || /[\r\n]/.test(file.file_id)) throw fault('MinerU 未返回有效的解析产物 ID。');
    let url = resolve(`files/${encodeURIComponent(file.file_id)}/content`);
    for (let redirect = 0; redirect < 4; redirect++) {
      const response = await fetch(url, { headers: headers(url), signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw fault('MinerU 产物重定向缺少地址。');
        url = new URL(location, url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('MinerU 产物下载地址无效。');
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw fault(`MinerU 解析产物下载失败（HTTP ${response.status}）。`); }
      return readLimited(response);
    }
    throw fault('MinerU 解析产物重定向次数过多。');
  }
  return { request, artifact, resolve, headers, base };
}

export async function mineruHealth(input = {}) {
  const settings = pdfParserSettings(input), signal = AbortSignal.timeout(15_000);
  try {
    const health = await transport(settings, signal).request('health');
    if (health.status !== 'ok') throw fault('MinerU 尚未就绪，请检查服务状态。', 503);
    return { ...publicParserSettings(settings), status: 'ok', version: health.version, features: health.features };
  } catch (error) { throw fault(`MinerU 健康检查失败：${safeMessage(error, settings)}`, 503); }
}

export async function parseMineruPdf(name, buffer, input = {}) {
  const settings = pdfParserSettings(input);
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const api = transport(settings, signal); let job;
  const started = Date.now();
  try {
    input.onProgress?.('检查 MinerU 服务');
    const health = await api.request('health');
    if (health.status !== 'ok' || !health.features?.sources?.includes('file_id') || !health.features?.output_formats?.includes('middle_json')) throw fault('MinerU 服务未就绪，或不支持所需的文件与布局输出。', 503);
    input.onProgress?.('上传 PDF');
    let upload = await api.request('uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: name, bytes: buffer.length, mime_type: 'application/pdf', purpose: 'parse', sha256sum: createHash('sha256').update(buffer).digest('hex') }) });
    if (upload.status !== 'completed') {
      if (upload.status !== 'pending' || typeof upload.id !== 'string' || !upload.id || !upload.upload_url || upload.upload_method !== 'PUT') throw fault('MinerU 上传响应缺少有效状态、地址或 ID。');
      const url = api.resolve(upload.upload_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('MinerU 上传地址无效。');
      const response = await fetch(url, { method: 'PUT', headers: { ...api.headers(url), ...upload.upload_headers, 'Content-Length': String(buffer.length) }, body: buffer, signal, redirect: 'manual' });
      if (!response.ok) { await response.body?.cancel(); throw fault(`MinerU 上传 PDF 失败（HTTP ${response.status}）。`); }
      await response.body?.cancel();
      upload = await api.request(`uploads/${encodeURIComponent(upload.id)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    if (upload.status !== 'completed' || typeof upload.file?.id !== 'string' || !upload.file.id) throw fault('MinerU 文件上传未完成或缺少文件 ID。');
    input.onProgress?.('提交解析任务');
    job = await api.request('parse/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ source: { type: 'file_id', file_id: upload.file.id } }], tier: settings.tier, ocr_mode: 'auto', output_formats: ['middle_json'] }) });
    const validate = value => {
      if (typeof value?.job_id !== 'string' || !value.job_id || !STATES.has(value.status)) throw fault('MinerU 返回了无效的任务 ID 或状态。');
    };
    validate(job); const jobId = job.job_id;
    while (!TERMINAL.has(job.status)) {
      input.onProgress?.(job.status === 'queued' ? 'MinerU 排队中' : 'MinerU 正在解析图表与公式');
      await delay(settings.pollIntervalMs, undefined, { signal });
      job = await api.request(`parse/jobs/${encodeURIComponent(jobId)}`); validate(job);
      if (job.job_id !== jobId) throw fault('MinerU 返回的任务 ID 与当前文件不一致。');
    }
    if (job.status !== 'completed' || job.files?.length !== 1 || job.files[0].status !== 'completed') throw fault(`MinerU 解析未完成（${job.status}）：${job.files?.[0]?.error?.message || '请检查服务日志后重新上传。'}`);
    if (job.files[0].file_id !== upload.file.id) throw fault('MinerU 解析结果与上传文件 ID 不一致，已停止入库。');
    input.onProgress?.('保存文字、公式与版面坐标');
    const bytes = await api.artifact(job.files[0].output_files?.middle_json);
    let middle;
    try { middle = JSON.parse(bytes.toString('utf8')); } catch { throw fault('MinerU 布局产物不是有效 JSON。'); }
    const normalized = normalizeMineruMiddle(middle, { pageCount: input.pageCount, requireFull: true });
    return { ...normalized, extraction: { provider: 'mineru', version: job.files[0].parse?.parser_version || health.version || 'unknown', schema: middle.schema, schemaVersion: middle.schema_version, tier: job.tier || settings.tier, model: job.files[0].parse?.model_used || null, mode: middle.extensions?.mineru?.parse_mode || 'auto', jobId, elapsedMs: Date.now() - started, serverDurationMs: job.files[0].parse?.duration_ms, createdAt: new Date().toISOString(), stats: normalized.stats } };
  } catch (error) {
    if (signal.aborted) {
      const suffix = job?.job_id ? `；服务任务 ${job.job_id} 可能仍在完成，未自动重复提交。` : '，未自动重复提交。';
      throw fault(`MinerU 解析等待超时或已取消${suffix}`, 504);
    }
    const network = error instanceof TypeError || ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error.cause?.code);
    throw fault(network ? '无法连接 MinerU 解析服务，请检查局域网服务是否启动，再重新上传。' : safeMessage(error, settings), error.status || (network ? 503 : 502));
  }
}

const clean = value => String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const noImages = text => String(text ?? '').replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[图像内容请核对原始页面]').replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[图像内容请核对原始页面]');
const contentOf = value => typeof value === 'string' ? noImages(value) : Array.isArray(value) ? value.map(inline).join('') : value && typeof value === 'object' ? inline(value) : '';
function inline(node) {
  if (typeof node === 'string') return noImages(node);
  const content = contentOf(node?.content ?? node?.text ?? '');
  return ['equation_inline', 'inline_equation'].includes(node?.type) && content ? `$${content}$` : content;
}
function decoded(text) {
  return text.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
    const code = parseInt(entity.slice(entity[2].toLowerCase() === 'x' ? 3 : 2, -1), entity[2].toLowerCase() === 'x' ? 16 : 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/[\r\n]+/g, ' ').trim();
}
function tableMarkdown(html) {
  if (!/<table\b/i.test(html)) return html;
  const rows = [], spans = new Map();
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = [];
    for (const [column, span] of spans) { row[column] = span.text; if (--span.remaining === 0) spans.delete(column); }
    let column = 0;
    for (const cell of match[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (row[column] !== undefined) column++;
      const attr = name => Math.max(1, Math.min(50, Number(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(cell[1])?.[1]) || 1));
      const colspan = attr('colspan'), rowspan = attr('rowspan'), text = decoded(cell[2]).replace(/\|/g, '\\|');
      for (let offset = 0; offset < colspan; offset++) { row[column + offset] = text; if (rowspan > 1) spans.set(column + offset, { text, remaining: rowspan - 1 }); }
      column += colspan;
    }
    if (row.length) rows.push(row);
  }
  if (!rows.length) return decoded(html);
  const columns = Math.max(...rows.map(row => row.length)), format = row => '| ' + Array.from({ length: columns }, (_, i) => row[i] || '').join(' | ') + ' |';
  return [format(rows[0]), format(Array(columns).fill('---')), ...rows.slice(1).map(format)].join('\n');
}
function normalizedBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(n => !Number.isFinite(n))) return [];
  const [x1, y1, x2, y2] = bbox;
  if (x1 < 0 || y1 < 0 || x2 > 1 || y2 > 1 || x2 <= x1 || y2 <= y1) return [];
  return [{ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }];
}

export function normalizeMineruMiddle(middle, { pageCount, requireFull = false } = {}) {
  if (middle?.schema !== 'docvortex.middle' || String(middle.schema_version).split('.')[0] !== '2' || !Array.isArray(middle.pages)) throw fault('MinerU 布局输出结构不受支持，需要 docvortex.middle v2。');
  if (requireFull && middle.is_full_document !== true) throw fault('MinerU 未返回完整论文，已停止入库，避免遗漏页面。');
  const physical = middle.metadata?.document?.page_count;
  const count = pageCount ?? physical;
  if (!Number.isInteger(count) || count < 1 || count > 500 || physical !== undefined && physical !== count) throw fault('MinerU 页数与原始 PDF 不一致，或超过 500 页限制。');
  const pages = Array(count).fill(''), sourceBlocks = Array.from({ length: count }, () => []), seen = new Set();
  const stats = { equations: 0, tables: 0, figures: 0 };
  for (const page of middle.pages) {
    const index = page.page_idx;
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index) || !Array.isArray(page.blocks)) throw fault('MinerU 页面编号重复、越界或内容格式无效。');
    seen.add(index);
    const append = (text, block, type = block.type) => {
      text = clean(text); if (!text) return;
      if (pages[index]) pages[index] += '\n\n';
      const start = pages[index].length; pages[index] += text;
      sourceBlocks[index].push({ start, end: pages[index].length, type, boxes: normalizedBox(block.bbox) });
    };
    for (const block of page.blocks) {
      if (!block || typeof block !== 'object') throw fault('MinerU 段落内容格式无效。');
      if (['image', 'chart', 'table'].includes(block.type)) {
        const children = Array.isArray(block.content) ? block.content : [];
        const body = children.find(child => child.type === `${block.type}_body`);
        const text = contentOf(body?.content ?? (typeof block.content === 'string' ? block.content : ''));
        if (block.type === 'table') { stats.tables++; append(text ? tableMarkdown(text) : '[表格区域：请核对原始页面，未提取到表格文字。]', body || block, 'table'); }
        else { stats.figures++; append(text || '[图像区域：图中数值和公式需通过原图读取或核验。]', body || block, block.type); }
        for (const child of children.filter(child => child !== body)) append(contentOf(child.content), child);
        for (const caption of [...(block.captions || []), ...(block.footnotes || [])]) append(contentOf(caption.content), caption, 'caption');
      } else if (block.type === 'equation') {
        const equation = contentOf(block.content); if (equation) { stats.equations++; append(`$$\n${equation}\n$$`, block); }
      } else {
        const content = contentOf(block.content);
        append(block.type === 'paragraph_title' && content ? `${'#'.repeat(Math.max(1, Math.min(6, Number(block.level) || 2)))} ${content}` : content, block);
      }
    }
  }
  return { pages, sourceBlocks, metadata: middle.metadata?.document || {}, stats };
}
