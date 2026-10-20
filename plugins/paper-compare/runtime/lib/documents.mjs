import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { parseMineruPdf, pdfParserSettings } from './mineru.mjs';

const execFileAsync = promisify(execFile);
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 2_000_000;
export const DEFAULT_CONTEXT_BUDGET = 250_000;
export const MAX_CONTEXT_BUDGET = 1_000_000;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md']);

function cleanText(text) {
  return text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

export function documentSummary(doc) {
  return { id: doc.id, name: doc.name, format: doc.format, pages: doc.pages.length,
    chars: doc.chars, contextChars: requiredContextChars(doc), bytes: doc.bytes, createdAt: doc.createdAt, sourceType: doc.sourceType,
    visualAvailable: !!doc.pdfBuffer || doc.format === 'pdf' && !!doc.hasFile, scanned: doc.format === 'pdf' && doc.chars < 30, fingerprint: documentFingerprint(doc), extractionVersion: doc.extractionVersion || 1,
    extraction: doc.extraction || (doc.format === 'pdf' ? { provider: 'poppler' } : undefined) };
}

export function documentFingerprint(doc) {
  doc.contentFingerprint ||= createHash('sha256').update(doc.pdfBuffer || JSON.stringify(doc.pages)).digest('hex');
  return doc.contentFingerprint;
}

export function pageParagraphs(doc, index) {
  const text = doc.pages[index] || '', prefix = doc.sourceType === 'page' ? 'P' : 'S';
  const paragraphs = []; let start = 0;
  for (const match of text.matchAll(/\n[ \t]*\n+/g)) {
    if (match.index > start) paragraphs.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < text.length) paragraphs.push({ start, end: text.length });
  return paragraphs.map((part, i) => ({ ...part, number: i + 1, page: index + 1, id: `${prefix}${index + 1}.${i + 1}`, text: text.slice(part.start, part.end) }));
}
export function formatSourcePage(doc, index) {
  const prefix = doc.sourceType === 'page' ? 'P' : 'S';
  const paragraphs = pageParagraphs(doc, index);
  return `[${prefix}${index + 1}]\n${paragraphs.map(part => `[${part.id}]\n${part.text}`).join('\n\n')}`;
}

export function requiredContextChars(doc) {
  return doc.pages.reduce((total, _, index) => total + formatSourcePage(doc, index).length, 0) + Math.max(0, doc.pages.length - 1) * 2;
}

export function textDocument(name, text, bytes = Buffer.byteLength(text), format = 'txt') {
  const cleaned = cleanText(text);
  if (cleaned.length < 20) throw new Error('文档没有足够的可读文本，请检查文件内容。');
  if (cleaned.length > MAX_DOCUMENT_CHARS) throw new Error('文档超过 200 万字符，请拆分后上传。');
  const pages = [];
  const paragraphs = cleaned.split(/\n\s*\n/);
  let block = '';
  for (const paragraph of paragraphs) {
    if (block && block.length + paragraph.length > 2800) { pages.push(block); block = ''; }
    if (paragraph.length > 5000) {
      if (block) { pages.push(block); block = ''; }
      for (let i = 0; i < paragraph.length; i += 2800) pages.push(paragraph.slice(i, i + 2800));
    } else block += (block ? '\n\n' : '') + paragraph;
  }
  if (block) pages.push(block);
  return { id: randomUUID(), name, format, pages, chars: cleaned.length, bytes, sourceType: 'section', createdAt: new Date().toISOString() };
}

export async function extractDocument(name, buffer, parser = { provider: 'poppler' }) {
  const extension = extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('支持 PDF、DOCX、TXT 和 Markdown 文件。');
  if (!buffer.length) throw new Error('文件为空。');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('单个文件最大支持 50 MB。');
  if (extension === '.txt' || extension === '.md') {
    let text;
    if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString('utf16le');
    else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const copy = Buffer.from(buffer.subarray(2));
      if (copy.length % 2) throw new Error('UTF-16 文本编码不完整。');
      text = copy.swap16().toString('utf16le');
    } else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new Error('文本编码无法识别，请先转换为 UTF-8 再上传。'); }
    }
    return textDocument(name, text.replace(/^\uFEFF/, ''), buffer.length, extension.slice(1));
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-compare-'));
  const path = join(directory, `upload${extension}`);
  try {
    await writeFile(path, buffer, { mode: 0o600 });
    if (extension === '.pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件不是有效的 PDF。');
      const settings = pdfParserSettings(parser);
      if (settings.provider === 'mineru') {
        let info;
        try { ({ stdout: info } = await execFileAsync(process.env.PDFINFO_PATH || 'pdfinfo', [path], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })); }
        catch (error) { throw new Error(error.code === 'ENOENT' ? '需要 Poppler 的 pdfinfo 验证原始页码；请先安装 poppler。' : 'PDF 校验失败，请确认文件未加密、未损坏。'); }
        const pageCount = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
        if (!pageCount || pageCount > 500) throw new Error('PDF 没有有效页面或超过 500 页，请检查或拆分后上传。');
        const parsed = await parseMineruPdf(name, buffer, { ...settings, pageCount });
        const chars = parsed.pages.reduce((sum, page) => sum + page.length, 0);
        if (chars > MAX_DOCUMENT_CHARS) throw new Error('文档超过 200 万字符，请拆分后上传。');
        return { id: randomUUID(), name, format: 'pdf', pages: parsed.pages, sourceBlocks: parsed.sourceBlocks, metadata: parsed.metadata, extraction: parsed.extraction, extractionVersion: 2, chars, bytes: buffer.length, pdfBuffer: buffer, sourceType: 'page', createdAt: new Date().toISOString() };
      }
      let stdout;
      try {
        ({ stdout } = await execFileAsync(process.env.PDFTOTEXT_PATH || 'pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], {
          timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
        }));
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('尚未安装 PDF 解析器。macOS 请执行 brew install poppler，然后重试。');
        throw new Error('PDF 解析失败，请确认文件未加密、未损坏，或先转成文本。');
      }
      const pages = stdout.split('\f').map(cleanText);
      if (pages.at(-1) === '') pages.pop();
      const chars = pages.reduce((total, page) => total + page.length, 0);
      if (!pages.length) throw new Error('PDF 没有有效页面。');
      if (pages.length > 500) throw new Error('PDF 最多支持 500 页，请拆分后上传。');
      if (chars > MAX_DOCUMENT_CHARS) throw new Error('文档超过 200 万字符，请拆分后上传。');
      return { id: randomUUID(), name, format: 'pdf', pages, chars, bytes: buffer.length, pdfBuffer: buffer, extractionVersion: 1, extraction: { provider: 'poppler' }, sourceType: 'page', createdAt: new Date().toISOString() };
    }
    let stdout;
    try {
      ({ stdout } = await execFileAsync('python3', ['-c', `
import sys, zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
    info = z.getinfo('word/document.xml')
    if info.file_size > 16000000:
        raise ValueError('Document XML is too large')
    root = ET.fromstring(z.read(info))
ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
paragraphs = []
for p in root.iter(ns + 'p'):
    parts = []
    for e in p.iter():
        if e.tag == ns + 't': parts.append(e.text or '')
        elif e.tag == ns + 'tab': parts.append('\\t')
        elif e.tag == ns + 'br': parts.append('\\n')
    paragraphs.append(''.join(parts))
sys.stdout.write('\\n\\n'.join(paragraphs))
`, path], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('DOCX 解析需要 Python 3，请安装后重试。');
      throw new Error('DOCX 解析失败，请确认文件有效，或另存为 PDF／TXT。');
    }
    return textDocument(name, stdout, buffer.length, 'docx');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function questionTerms(question) {
  const lower = question.toLowerCase();
  const terms = [...lower.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)].map(match => match[0]);
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    for (let i = 0; i < match[0].length - 1; i++) terms.push(match[0].slice(i, i + 2));
  }
  const hints = [
    [/方法|模型|架构|method|model|architecture/i, ['method', 'model', 'architecture', 'approach', '方法', '模型']],
    [/实验|结果|指标|评估|experiment|result|evaluation/i, ['experiment', 'result', 'evaluation', 'benchmark', '实验', '结果']],
    [/局限|不足|limit|weakness/i, ['limitation', 'discussion', 'future', '局限', '不足']],
    [/贡献|创新|核心|摘要|总结|contribut|summary/i, ['abstract', 'introduction', 'contribution', 'conclusion', '摘要', '结论']],
  ];
  for (const [pattern, words] of hints) if (pattern.test(question)) terms.push(...words);
  return [...new Set(terms)];
}

export function selectContext(doc, question, budget = DEFAULT_CONTEXT_BUDGET) {
  budget = Math.max(4000, Math.min(MAX_CONTEXT_BUDGET, Math.floor(budget)));
  const prefix = doc.sourceType === 'page' ? 'P' : 'S';
  const formatPage = index => formatSourcePage(doc, index);
  const full = doc.pages.map((_, index) => formatPage(index)).join('\n\n');
  if (full.length <= budget) return { text: full, mode: 'full', totalPages: doc.pages.length,
    selectedPages: doc.pages.map((_, index) => index + 1), chars: full.length, budget };
  const terms = questionTerms(question);
  const scored = doc.pages.map((page, index) => {
    const lower = page.toLowerCase();
    let score = index === 0 ? 30 : index === doc.pages.length - 1 ? 12 : 0;
    if (/abstract|conclusion|摘要|结论/i.test(page.slice(0, 200))) score += 8;
    for (const term of terms) {
      let start = 0, hits = 0;
      while (hits < 20 && (start = lower.indexOf(term, start)) !== -1) { hits++; start += term.length; }
      score += hits * (term.length > 3 ? 3 : 1);
    }
    return { index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = [];
  let used = 0;
  for (const item of scored) {
    const text = formatPage(item.index);
    if (used + text.length + 2 > budget) continue;
    chosen.push(item.index); used += text.length + 2;
  }
  if (!chosen.length) {
    const text = `${formatPage(scored[0].index).slice(0, budget - 40)}\n[该页因长度限制仅包含部分文字]`;
    return { text, mode: 'selected', partialPage: true, totalPages: doc.pages.length,
      selectedPages: [scored[0].index + 1], chars: text.length, budget };
  }
  chosen.sort((a, b) => a - b);
  const text = chosen.map(formatPage).join('\n\n');
  return { text, mode: 'selected', totalPages: doc.pages.length,
    selectedPages: chosen.map(index => index + 1), chars: text.length, budget };
}
