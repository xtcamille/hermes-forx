import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { mineruHealth, pdfParserSettings } from '../lib/mineru.mjs';
import { extractDocument, documentSummary, MAX_UPLOAD_BYTES } from '../lib/documents.mjs';

try {
  const settings = pdfParserSettings({ provider: 'mineru' });
  console.log(JSON.stringify(await mineruHealth(settings), null, 2));
  const path = process.argv[2];
  if (path) {
    if ((await stat(path)).size > MAX_UPLOAD_BYTES) throw new Error('测试文件最大 50 MB。');
    const doc = await extractDocument(basename(path), await readFile(path), settings);
    console.log(JSON.stringify({ ...documentSummary(doc), paragraphs: doc.sourceBlocks.map(blocks => blocks.length) }, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
