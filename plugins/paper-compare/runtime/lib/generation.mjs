import { chatCompletion, safeError } from './gateway.mjs';

export function appendContinuation(previous, next) {
  if (previous && next.startsWith(previous)) return next;
  const limit = Math.min(previous.length, next.length, 8192);
  for (let count = limit; count >= 16; count--) if (previous.endsWith(next.slice(0, count))) return previous + next.slice(count);
  // A short repeated opener can leave two nested math delimiters at a token
  // boundary. Only merge it after the continuation supplies its real closer.
  for (const [open, close] of [['\\(', '\\)'], ['\\[', '\\]']]) {
    const at = previous.lastIndexOf(open);
    if (at < 0 || at <= previous.lastIndexOf(close) || !previous.slice(at + open.length).trim()) continue;
    for (let count = Math.min(limit, 15); count >= open.length + 2; count--) {
      const prefix = next.slice(0, count);
      if (prefix.includes(open) && previous.endsWith(prefix) && next.indexOf(close, count) >= 0) return previous + next.slice(count);
    }
  }
  return previous + next;
}
export function aggregateUsage(parts) {
  const totals = {};
  for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const values = parts.map(p => p.usage?.[name]);
    if (values.some(Number.isFinite)) totals[name] = values.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  }
  if (parts.some(p => !p.usage)) totals.partial = true;
  return Object.keys(totals).length ? totals : null;
}
export async function generate(config, output, messages, { signal, maxTokens, temperature = 0.2, autoContinuations = 2, changed = () => {} } = {}) {
  output.segments ||= []; output.text ||= ''; output.status = 'running';
  delete output.stopReason;
  const started = Date.now();
  const remaining = Math.max(0, autoContinuations - output.segments.filter(s => s.automatic).length);
  for (let call = 0; call <= remaining; call++) {
    signal?.throwIfAborted();
    const previous = output.text;
    const continuation = previous ? [...messages, { role: 'assistant', content: previous }, { role: 'user', content: '接着上面的正文断点继续，不要重写或复述已有内容。不重复标题或开头；若断在公式、代码或表格中，先完成该部分。保持原有引用，完成原问题尚未回答的部分。' }] : messages;
    const segment = { index: output.segments.length, text: '', automatic: call > 0, status: 'running', startedAt: new Date().toISOString() };
    output.segments.push(segment); output.status = previous ? 'continuing' : 'running'; changed();
    try {
      const result = await chatCompletion(config, { model: output.model, messages: continuation, maxTokens, temperature, signal,
        onRequest: count => { segment.requestCount = count; output.callCount = output.segments.reduce((n, s) => n + (s.requestCount || 0), 0); changed(); },
        onDelta: delta => { segment.text += delta; output.text = appendContinuation(previous, segment.text); changed(); },
        onReasoning: value => { output.reasoningChars = value.reasoningChars; changed(); }, onTransport: value => { output.streaming = value.streaming; changed(); } });
      Object.assign(segment, result, { status: 'done' });
      output.text = appendContinuation(previous, segment.text);
      output.usage = aggregateUsage(output.segments); output.finishReason = result.finishReason; output.streaming = result.streaming;
      output.firstTokenMs ??= result.firstTokenMs; output.elapsedMs = (output.elapsedMs || 0) + result.elapsedMs;
      if (output.text.trim() === previous.trim()) { output.status = 'incomplete'; output.error = '续写没有新增内容，已停止自动调用。'; break; }
      const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens;
      const generatedTokens = result.usage?.completion_tokens;
      const addedChars = output.text.length - previous.length;
      if (result.finishReason === 'length' && addedChars < 80 && reasoningTokens > 0 && reasoningTokens / generatedTokens >= .95) {
        output.status = 'incomplete'; output.stopReason = 'reasoning_budget';
        const limit = output.kind === 'analysis' || output.kind === 'claims' ? 65536 : output.kind === 'verification' ? 12000 : 32768;
        const suggestion = maxTokens < limit ? `可将输出预算提高到 ${Math.min(limit, Math.max(12000, maxTokens * 2))} tokens 后手动继续，或更换模型` : '已达到此区域的输出上限，请缩小问题范围或更换模型';
        output.error = `本次输出预算几乎全部用于思考，仅新增 ${addedChars} 字符，已停止自动调用。${suggestion}；已有内容已保存。`;
        break;
      }
      if (result.finishReason !== 'length') { output.status = 'done'; break; }
      output.status = 'incomplete'; changed();
    } catch (error) {
      segment.status = signal?.aborted ? 'cancelled' : 'error'; segment.error = safeError(error, config.apiKey);
      output.status = signal?.aborted ? 'cancelled' : output.text ? 'interrupted' : 'error';
      output.error = safeError(error, config.apiKey); output.elapsedMs ||= Date.now() - started;
      changed(); throw error;
    }
  }
  output.callCount = output.segments.reduce((n, s) => n + (s.requestCount || 1), 0); output.usage = aggregateUsage(output.segments); changed();
  return output;
}

export const CLAIM_INSTRUCTION = `分析正文之前，先输出一个以 \`\`\`claims 开始、以 \`\`\` 结束的 JSON 数组代码块，最多12条。每条为 {"text":"待核验的具体结论","positions":[{"model":"模型ID","text":"该模型观点"}],"refs":["P1.2"],"question":"待核验事项"}。只能使用已提供的引用编号。之后输出正常的共识、分歧、证据和综合结论 Markdown。卡片是待核验事项，不表示结论已经成立。`;
export function parseAnalysis(text) {
  const opening = /```claims\s*\n/.exec(text);
  if (!opening) return { text, claims: null };
  const end = text.indexOf('```', opening.index + opening[0].length);
  if (end < 0) {
    // Emit only complete JSON objects. Quotes and escaped braces may span chunks.
    const raw = text.slice(opening.index + opening[0].length), complete = [];
    let depth = 0, start = -1, quoted = false, escaped = false;
    if (!raw.trimStart().startsWith('[')) return { text: text.slice(0, opening.index), claims: null, pending: true };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') { if (!depth) start = i; depth++; }
      else if (c === '}' && depth && --depth === 0) { try { complete.push(JSON.parse(raw.slice(start, i + 1))); } catch { break; } }
    }
    const partial = complete.length ? parseAnalysis('```claims\n' + JSON.stringify(complete) + '\n```').claims : null;
    return { text: text.slice(0, opening.index), claims: partial, pending: true };
  }
  try {
    const list = JSON.parse(text.slice(opening.index + opening[0].length, end));
    if (!Array.isArray(list)) throw new Error('Expected array');
    const claims = list.slice(0, 12).filter(x => typeof x?.text === 'string' && x.text.trim()).map(x => ({ text: x.text.slice(0, 4000), question: typeof x.question === 'string' ? x.question.slice(0, 2000) : '', refs: (Array.isArray(x.refs) ? x.refs : []).filter(r => typeof r === 'string' && /^[PS]\d+(\.\d+)?$/.test(r)).slice(0, 30), positions: (Array.isArray(x.positions) ? x.positions : []).filter(p => typeof p?.model === 'string' && typeof p?.text === 'string').map(p => ({ model: p.model.slice(0, 200), text: p.text.slice(0, 2000) })) }));
    return { text: (text.slice(0, opening.index) + text.slice(end + 3)).trimStart(), claims };
  } catch { return { text, claims: null, error: '结论清单格式无效，可点击重新整理。' }; }
}
