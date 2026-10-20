import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageParagraphs } from './documents.mjs';
const exec = promisify(execFile);
export const PDF_LAYOUT_VERSION = 3;
const normalized = value => String(value).normalize('NFKC').replace(/[\s\u00ad\u0000-\u001f]/g, '');

export async function pageLayout(doc, page) {
  if (!Number.isInteger(page) || page < 1 || page > doc.pages.length) throw new Error('页码无效。');
  const paragraphs = pageParagraphs(doc, page - 1);
  if (doc.extraction?.provider === 'mineru') {
    return { page, provider: 'mineru', granularity: 'block', extractionVersion: doc.extractionVersion || 2, paragraphs: paragraphs.map(part => {
      const block = doc.sourceBlocks?.[page - 1]?.find(block => block.start <= part.start && block.end >= part.end);
      const boxes = (block?.boxes || []).filter(box => [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1.001 && box.y + box.height <= 1.001);
      return { ...part, boxes, located: !!boxes.length, granularity: 'block', reason: boxes.length ? 'MinerU 版面区域定位，非逐字定位。' : 'MinerU 未提供可靠区域坐标，已定位到原始页面。' };
    }) };
  }
  if (!doc.pdfBuffer) return { page, paragraphs: paragraphs.map(p => ({ ...p, boxes: [], located: false })), reason: '没有 PDF 文字坐标。' };
  const directory = await mkdtemp(join(tmpdir(), 'paper-layout-'));
  try {
    const path = join(directory, 'source.pdf'); await writeFile(path, doc.pdfBuffer, { mode: 0o600 });
    const { stdout } = await exec('python3', ['-c', `import subprocess,sys,json,re,os,xml.etree.ElementTree as E
r=subprocess.run([sys.argv[1],'-f',sys.argv[3],'-l',sys.argv[3],'-bbox-layout',sys.argv[2],'-'],capture_output=True,check=True)
# Poppler can emit raw C0 glyph codes in math fonts. They are illegal in XML
# and must not prevent locating unrelated, readable lines on the same page.
xml=re.sub(rb'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]',b'',r.stdout)
root=E.fromstring(xml); ns={'x':'http://www.w3.org/1999/xhtml'}; pg=root.find('.//x:page',ns)
i=subprocess.run([sys.argv[4],'-f',sys.argv[3],'-l',sys.argv[3],'-box',sys.argv[2]],capture_output=True,check=True,env=dict(os.environ,LC_ALL='C'))
rotation=re.search(r'rot:\\s*(-?\\d+)',i.stdout.decode('utf-8','replace'))
if not rotation: raise ValueError('Cannot confirm PDF page rotation')
w,h=float(pg.attrib['width']),float(pg.attrib['height'])
if int(rotation[1])%180: w,h=h,w
print(json.dumps({'width':w,'height':h,'rotation':int(rotation[1]),'lines':[[dict(text=w.text or '',**{k:float(v) for k,v in w.attrib.items()}) for w in line.findall('x:word',ns)] for line in pg.findall('.//x:line',ns)]}))`, process.env.PDFTOTEXT_PATH || 'pdftotext', path, String(page), process.env.PDFINFO_PATH || 'pdfinfo'], { timeout: 45_000, maxBuffer: 12 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    const lines = data.lines.map(words => { let text = ''; const spans = words.map(word => { const start = text.length; text += normalized(word.text); return { ...word, start, end: text.length }; }); return { text, spans }; });
    return { page, width: data.width, height: data.height, extractionVersion: doc.extractionVersion || 1, paragraphs: paragraphs.map(part => {
      const pieces = part.text.split(/\n| {2,}/).map(normalized).filter(Boolean), boxes = []; let located = pieces.length > 0;
      for (const piece of pieces) {
        const matches = [];
        for (const line of lines) { let start = line.text.indexOf(piece); while (start >= 0) { matches.push({ line, start }); start = line.text.indexOf(piece, start + 1); } }
        if (matches.length !== 1) { located = false; break; }
        const { line, start } = matches[0], words = line.spans.filter(w => w.end > start && w.start < start + piece.length);
        if (!words.length) { located = false; break; }
        const x = Math.min(...words.map(w => w.xMin)), y = Math.min(...words.map(w => w.yMin));
        boxes.push({ x: x / data.width, y: y / data.height, width: (Math.max(...words.map(w => w.xMax)) - x) / data.width, height: (Math.max(...words.map(w => w.yMax)) - y) / data.height });
      }
      if (boxes.some(b => b.x < 0 || b.y < 0 || b.x + b.width > 1.001 || b.y + b.height > 1.001)) located = false;
      return { ...part, boxes: located ? boxes : [], located, reason: located ? '' : '文字与页面坐标无法唯一匹配，已定位到原始页面。' };
    }) };
  } catch {
    return { page, paragraphs: paragraphs.map(part => ({ ...part, boxes: [], located: false, reason: '无法可靠解析 PDF 页面坐标，已降级到页级定位。' })) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
