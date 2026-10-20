export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请输入有效的接口地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址需为 HTTP／HTTPS，且不能包含账号、查询参数或片段。');
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  if (!path) path = '/v1';
  return `${url.origin}${path}`;
}

export function safeError(error, key = '') {
  let text = typeof error === 'string' ? error : error?.message || '请求失败，请重试。';
  if (/^(terminated|fetch failed)$/i.test(text)) text = '上游接口中断了连接，请重试；若在读取图片时发生，可减少一次读取的页数。';
  if (key) text = text.split(key).join('[密钥已隐藏]');
  return text.replace(/sk-[\w-]{12,}/g, '[密钥已隐藏]').replace(/Bearer\s+[\w.\/-]+/gi, 'Bearer [已隐藏]').slice(0, 700);
}

async function responseError(response) {
  const text = (await response.text()).slice(0, 8000);
  let message;
  try { const data = JSON.parse(text); message = data.error?.message || data.message || data.error; } catch {}
  if (typeof message !== 'string') message = text.startsWith('<') ? '接口返回了网页，请检查 /v1 地址。' : text;
  return `HTTP ${response.status}：${message || response.statusText}`;
}

export async function listModels(config, signal) {
  if (!config.apiKey) throw new Error('请先在接口设置中填写 API 密钥。');
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: modelHeaders(config),
    signal: signal || AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error('接口未返回兼容 OpenAI 的模型列表。可在界面中手动添加模型 ID。');
  return [...new Set(data.data.filter(item => typeof item.id === 'string').map(item => item.id))].sort();
}

function modelHeaders(config, json = false) {
  const headers = new Headers(config.extraHeaders || {});
  headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (json) headers.set('Content-Type', 'application/json');
  return headers;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item.text || '').join('');
  return '';
}

export async function chatCompletion(config, { model, messages, temperature = 0.2, maxTokens = 12000, timeoutMs = 600_000, signal, onDelta, onReasoning, onTransport, onRequest }) {
  const started = Date.now();
  const requestSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
  let response, requestCount = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    onRequest?.(++requestCount);
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST', headers: modelHeaders(config, true),
      body: JSON.stringify(body), signal: requestSignal,
    });
    if (response.ok) break;
    const message = await responseError(response);
    if (![400, 422].includes(response.status)) throw new Error(message);
    if (/max_tokens/.test(message) && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens; delete body.max_tokens;
    } else if (/temperature/i.test(message) && body.temperature !== undefined) delete body.temperature;
    else if (body.stream_options) delete body.stream_options;
    else if (body.stream && /stream|流式/i.test(message)) body.stream = false;
    else throw new Error(message);
    if (attempt === 4) throw new Error(message);
  }
  const streaming = (response.headers.get('content-type') || '').includes('text/event-stream');
  onTransport?.({ streaming });
  let answer = '', usage = null, finishReason = null, firstTokenMs = null, reasoningChars = 0, lastReasoningUpdate = 0;
  const acceptDelta = delta => {
    if (!delta) return;
    if (firstTokenMs === null) firstTokenMs = Date.now() - started;
    answer += delta; onDelta?.(delta);
  };
  const accept = data => {
    if (data.error) throw new Error(data.error.message || '模型返回错误。');
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    const reasoning = contentText(choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.message?.reasoning_content);
    if (reasoning) { reasoningChars += reasoning.length; if (Date.now() - lastReasoningUpdate > 250) { onReasoning?.({ reasoningChars }); lastReasoningUpdate = Date.now(); } }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    acceptDelta(contentText(choice?.delta?.content ?? choice?.message?.content));
  };
  if (!streaming) {
    accept(await response.json());
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', sawDone = false;
    const parseEvent = event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') { sawDone = true; return; }
      try { accept(JSON.parse(data)); } catch (error) {
        if (error instanceof SyntaxError) throw new Error('模型流式响应格式无效，请重试或换一个模型。');
        throw error;
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          parseEvent(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        }
        if (buffer.length > 4 * 1024 * 1024) throw new Error('模型流式响应过大。');
        if (done) { if (buffer.trim()) parseEvent(buffer); break; }
      }
    } finally { reader.releaseLock(); }
    if (!sawDone && !finishReason) throw new Error('上游流式连接在完成标记之前中断，请重试。');
  }
  if (!answer.trim()) throw new Error('模型没有返回可展示的回答，可能只返回了推理过程，请增大输出长度或切换模型。');
  return { text: answer, usage, finishReason, firstTokenMs, elapsedMs: Date.now() - started, streaming, reasoningChars, requestCount };
}
