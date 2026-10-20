import { randomUUID } from 'node:crypto';
import { generate, aggregateUsage } from './generation.mjs';
import { safeError } from './gateway.mjs';
import { evidenceCatalogue, sourceEvidence, rememberEvidence, nearbyEvidence, sourcePack, searchEvidence, GAP_PLAN_INSTRUCTION, parseGapPlan } from './evidence.mjs';
import { verifiedVision } from './vision.mjs';

export const INVESTIGATION_LIMITS = Object.freeze({ rounds: 2, pages: 6, regionReads: 2, sourceChars: 45000 });
export function parseVerdict(text) { return /^\s*(?:#{1,6}\s*)?\*{0,2}判定\*{0,2}[：:]\s*\*{0,2}(支持|部分支持|存在矛盾|证据不足)/m.exec(text)?.[1] || '证据不足'; }
export function nextGaps(text) {
  const match = /```evidence-gaps\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return { queries: [], gaps: [] };
  return parseGapPlan(match[1]);
}
export const visibleInvestigationText = text => text.replace(/```evidence-gaps\b[\s\S]*?(?:```|$)/g, '').trimEnd();
export async function investigate({ library, readings, vision, doc, config, model, reader, claim, output, signal, changed, scope, instruction }) {
  const catalogue = evidenceCatalogue(doc), all = catalogue.paragraphs;
  output.limits = INVESTIGATION_LIMITS; output.rounds = []; output.readings = []; output.gaps = []; output.status = 'running'; output.reader = reader; output.sameReader = reader === model;
  const emit = changed;
  changed = () => {
    const charged = [output.planner, ...output.rounds.map(r => r.generation), ...output.readings.filter(r => !r.cached)].filter(Boolean);
    output.callCount = charged.reduce((n, g) => n + (g.callCount || 0), 0); output.usage = aggregateUsage(charged); emit();
  };
  output.inputAudit = { ...scope, documentId: doc.id, extractionVersion: doc.extractionVersion || 1, model, history: [], privateContext: false, evidenceIds: [] };
  const original = (claim.refs || []).map(r => sourceEvidence(doc, r)).filter(r => r.valid);
  const initial = sourcePack(original.flatMap(r => r.paragraph ? nearbyEvidence(doc, r) : all.filter(p => p.page === r.page)), 16000);
  output.phase = '梳理本条结论的证据缺口'; changed();
  const planner = { id: randomUUID(), model, kind: 'evidence-plan', text: '', segments: [], status: 'waiting' }; output.planner = planner;
  // This is a neutral navigation catalogue, not any model's private note or answer.
  const navigation = catalogue.objects.map(o => `${o.label} [${o.ref}] ${o.caption.slice(0, 130)}`).concat(doc.pages.flatMap((_, i) => {
    const headings = all.filter(p => p.page === i + 1 && /^#+\s/.test(p.text)); return headings.map(p => `[${p.ref}] ${p.text.slice(0, 130)}`);
  })).join('\n').slice(0, 22000);
  try {
    await generate(config, planner, [{ role: 'system', content: GAP_PLAN_INSTRUCTION }, { role: 'user', content: `待核验结论：${claim.text}\n待核验事项：${claim.question || ''}\n已有原文（不等于支持）：\n${initial.text}\n可导航目录：\n${navigation}` }], { signal, maxTokens: 4096, autoContinuations: 0, changed });
  } catch (error) { if (signal.aborted) throw error; output.planningError = safeError(error, config.apiKey); }
  const plan = parseGapPlan(planner.text), selected = new Map(), allowedPages = new Set();
  let queries = [...plan.queries, claim.text, claim.question || '']; output.gaps = plan.gaps;
  const add = record => {
    if (!record?.valid || selected.has(record.id)) return;
    if (!allowedPages.has(record.page) && allowedPages.size >= INVESTIGATION_LIMITS.pages) return;
    selected.set(record.id, record); allowedPages.add(record.page);
  };
  // Direct references remain available, but new targeted matches receive room before
  // adjacent prose. A whole wrong page must not crowd out the missing formula/table.
  const referenced = plan.refs.map(r => sourceEvidence(doc, r)).filter(r => r.valid);
  for (let roundIndex = 0; roundIndex < INVESTIGATION_LIMITS.rounds; roundIndex++) {
    signal.throwIfAborted(); output.phase = `补查原文 · 第 ${roundIndex + 1}/${INVESTIGATION_LIMITS.rounds} 轮`; changed();
    const candidates = searchEvidence(doc, queries, { exclude: [...selected.keys()], limit: 16 }), before = selected.size;
    const seeds = [...(roundIndex ? [] : referenced), ...candidates].slice(0, 8);
    seeds.forEach(add);
    if (!roundIndex) initial.provided.forEach(add);
    seeds.forEach(record => nearbyEvidence(doc, record).forEach(add));
    if (selected.size === before && roundIndex) { output.stopReason = 'no_new_evidence'; break; }
    const pack = sourcePack([...selected.values()], INVESTIGATION_LIMITS.sourceChars);
    if (!pack.provided.length) { output.status = 'done'; output.verdict = '证据不足'; output.text = '判定：证据不足\n\n没有检索到可提供的原文段落。请补充图表编号、关键词或有效引用后重试。'; output.stopReason = 'no_evidence'; break; }
    const sources = rememberEvidence(library, doc, pack.provided.map(p => p.ref), { ...scope, role: 'verification-source', generationId: output.id, round: roundIndex + 1, model });
    const round = { index: roundIndex + 1, queries, gaps: output.gaps, candidates: candidates.map(c => ({ ref: c.ref, evidenceId: c.id, score: c.score })), evidenceIds: sources.map(s => s.id), refs: sources.map(s => s.ref), pages: [...new Set(sources.map(s => s.page))], readingIds: [] };
    output.rounds.push(round); output.evidenceIds = sources.map(s => s.id); output.inputAudit.evidenceIds = output.evidenceIds;
    output.pages = round.pages; output.coverage = `实际提供 ${sources.length} 段 · 第 ${round.pages.join('、')} 页 · 补查 ${round.index}/${INVESTIGATION_LIMITS.rounds} 轮`;
    if (verifiedVision(vision, reader) && doc.pdfBuffer) {
      const targets = catalogue.objects.filter(o => pack.provided.some(p => p.id === o.id) && !output.readings.some(r => r.evidenceId === o.id)).sort((a,b) => pack.provided.findIndex(p => p.id === a.id) - pack.provided.findIndex(p => p.id === b.id));
      for (const target of targets.slice(0, INVESTIGATION_LIMITS.regionReads - output.readings.length)) {
        output.phase = `精读 ${target.label} [${target.ref}]`; changed();
        const entry = { evidenceId: target.id, ref: target.ref, model: reader, status: 'running' }; output.readings.push(entry);
        try {
          const result = await readings.read(config, reader, doc, target, signal, (reading, cached) => { Object.assign(entry, { readingId: reading.id, status: reading.status, cached, text: reading.text, phase: reading.phase, location: reading.location, callCount: cached ? 0 : reading.callCount, usage: cached ? null : reading.usage }); changed(); }, { ...scope, generationId: output.id });
          Object.assign(entry, { readingId: result.reading.id, cached: result.cached, status: result.reading.status, text: result.reading.text, callCount: result.cached ? 0 : result.reading.callCount, usage: result.cached ? null : result.reading.usage });
          round.readingIds.push(entry.readingId);
        } catch (error) { if (signal.aborted) throw error; entry.status = 'error'; entry.error = safeError(error, config.apiKey); }
      }
    } else output.visualLimitation = '没有可用且已验证的视觉读取模型，本次只补查提取文字，图中细节仍属于证据缺口。';
    const derived = output.readings.filter(r => r.status === 'done' && pack.provided.some(p => p.id === r.evidenceId));
    const judge = { id: randomUUID(), model, kind: 'verification', text: '', segments: [], status: 'waiting' }; round.generation = judge;
    output.phase = `核验实际读到的证据 · 第 ${round.index} 轮`; output.text = ''; changed();
    const content = `待核验结论：${claim.text}\n待核验事项：${claim.question || ''}\n原始引用检查（仅表明存在）：${JSON.stringify((output.references || original).map(r => ({ ref: r.ref, valid: r.valid })))}\n原文 v${doc.extractionVersion || 1}，仅实际提供下列 ${sources.length} 段，未提供其余页面全文：\n${pack.text}\n视觉精读（模型 ${reader} 生成的衍生资料，可能有误，不能作为独立验证的事实）：\n${derived.map(r => `[${r.ref}] 精读ID ${r.readingId}\n${r.text}`).join('\n\n') || '无'}\n视觉限制：${output.visualLimitation || '仅上述对象及其页面图片被视觉读取，其他图表未读取。'}\n检索候选仅用于导航，不能把未提供的候选视作证据。`;
    await generate(config, judge, [{ role: 'system', content: instruction + '\n若仍存在影响判定的证据缺口，在正文末尾输出 ```evidence-gaps 的 JSON 代码块，内容为 {"gaps":["尚缺的具体条件"],"queries":["下一次检索的英文关键词或图表公式编号"]}。若已足够则两个数组均为空。明确区分提取原文与模型视觉精读。' }, { role: 'user', content }], { signal, maxTokens: 12000, autoContinuations: 0, changed: () => { output.text = visibleInvestigationText(judge.text); output.status = judge.status; changed(); } });
    round.verdict = parseVerdict(judge.text); output.verdict = round.verdict; output.status = judge.status;
    const next = nextGaps(judge.text); output.gaps = next.gaps; output.text = visibleInvestigationText(judge.text).trim();
    if (!['证据不足', '部分支持'].includes(round.verdict) || !next.queries.length || judge.status !== 'done') { output.stopReason = judge.status !== 'done' ? 'generation_incomplete' : next.gaps.length ? 'unresolved_gaps' : 'judged'; break; }
    queries = next.queries;
  }
  if (!output.stopReason) output.stopReason = 'budget_reached';
  output.phase = ''; output.reader = reader; output.sameReader = reader === model;
  output.segments = output.rounds.flatMap(r => r.generation?.segments || []);
  const charged = [output.planner, ...output.rounds.map(r => r.generation), ...output.readings.filter(r => !r.cached)].filter(Boolean);
  output.callCount = charged.reduce((n, g) => n + (g.callCount || 0), 0); output.usage = aggregateUsage(charged); changed();
}
