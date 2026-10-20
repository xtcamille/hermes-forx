import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractDocument, selectContext, textDocument, requiredContextChars, pageParagraphs, documentFingerprint } from '../lib/documents.mjs';
import { samplePdf } from './fixtures.mjs';

test('PDF extraction preserves original page numbering, including empty pages', async () => {
  const doc = await extractDocument('paper.pdf', samplePdf(['Abstract. This paper contains methods and results.', '', 'Limitations. Small sample size and no independent replication.']));
  assert.equal(doc.sourceType, 'page'); assert.equal(doc.pages.length, 3);
  assert.equal(doc.pages[1], ''); assert.match(doc.pages[2], /Limitations/);
  assert.match(selectContext(doc, '局限').text, /\[P3\]/);
});
test('scanned PDFs retain original pages for vision; invalid files receive actionable errors', async () => {
  const scan = await extractDocument('scan.pdf', samplePdf([''])); assert.equal(scan.chars, 0); assert.ok(scan.pdfBuffer); assert.equal(scan.pages.length, 1);
  await assert.rejects(extractDocument('invalid.pdf', Buffer.from('not a PDF')), /有效的 PDF/);
  await assert.rejects(extractDocument('archive.zip', Buffer.from('unknown')), /支持 PDF/);
});
test('DOCX extracts paragraphs and table cells without installing dependencies', async () => {
  const { stdout } = await promisify(execFile)('python3', ['-c', `
import io, zipfile, sys
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Study methods and evidence in a DOCX document.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table result: 86 percent.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())
`], { encoding: 'buffer' });
  const doc = await extractDocument('paper.docx', stdout);
  assert.match(doc.pages.join('\n'), /Study methods/); assert.match(doc.pages.join('\n'), /Table result/);
});
test('UTF-16 text is decoded and invalid encodings are rejected', async () => {
  const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('论文方法与实验结果需要基于原文证据进行对照分析。', 'utf16le')]);
  const doc = await extractDocument('论文.txt', data); assert.match(doc.pages[0], /论文方法/);
  await assert.rejects(extractDocument('bad.txt', Buffer.from([0xff, 0xa0, 0x80])), /UTF-8/);
});
test('long context selects relevant evidence, remains within budget, and keeps source labels', () => {
  const doc = { name: 'long.pdf', sourceType: 'page', pages: Array.from({ length: 12 }, (_, index) => `${index === 8 ? 'EXPERIMENT RESULTS EVALUATION benchmark accuracy' : 'General background'}\n${'content '.repeat(240)}`) };
  const context = selectContext(doc, '解释实验结果与评估指标', 6000);
  assert.equal(context.mode, 'selected'); assert.ok(context.chars <= 6000);
  assert.ok(context.selectedPages.includes(9)); assert.match(context.text, /\[P9\]/);
  assert.deepEqual([...context.selectedPages].sort((a, b) => a - b), context.selectedPages);
});
test('an oversized page clearly reports partial coverage', () => {
  const context = selectContext({ sourceType: 'page', pages: ['methods '.repeat(2000)] }, 'methods', 4000);
  assert.equal(context.mode, 'selected'); assert.equal(context.partialPage, true);
  assert.ok(context.chars <= 4000); assert.match(context.text, /仅包含部分文字/);
});
test('short documents are sent in full with section labels', () => {
  const doc = textDocument('paper.md', '研究方法：多个模型回答同一问题。\n\n实验结果：检查原文引用是否支持各自结论。');
  const context = selectContext(doc, '研究方法是什么'); assert.equal(context.mode, 'full'); assert.match(context.text, /\[S1\]/);
});
test('a 174k-character paper is included in full at the new default budget', () => {
  const doc = { sourceType: 'page', pages: Array.from({ length: 27 }, (_, index) => `Page ${index + 1}\n${'evidence '.repeat(717)}`) };
  assert.ok(requiredContextChars(doc) > 170_000);
  const previous = selectContext(doc, 'methods', 120_000); assert.equal(previous.mode, 'selected');
  const current = selectContext(doc, 'methods'); assert.equal(current.mode, 'full'); assert.equal(current.selectedPages.length, 27);
  assert.match(current.text, /\[P27\]/); assert.equal(current.chars, requiredContextChars(doc));
});
test('paragraph anchors preserve exact source offsets and count toward context budgets', () => {
  const doc = { sourceType: 'page', pages: ['First paragraph.\n\n  Second paragraph with indentation.\n\nThird paragraph.'] };
  const paragraphs = pageParagraphs(doc, 0); assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[1].id, 'P1.2');
  for (const part of paragraphs) assert.equal(doc.pages[0].slice(part.start, part.end), part.text);
  const context = selectContext(doc, 'evidence'); assert.match(context.text, /\[P1.2\]\n  Second paragraph/);
  assert.equal(requiredContextChars(doc), context.chars);
  assert.equal(documentFingerprint(doc), documentFingerprint({ ...doc, id: 'different-upload-id' }));
});
