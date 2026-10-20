import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unionBoxes, validBox, hash } from './evidence.mjs';
import { pageLayout } from './pdf-layout.mjs';
import { renderPageImage, imageContent } from './vision.mjs';

const exec = promisify(execFile), cache = new Map();
export const REGION_RENDER_VERSION = 1;
export async function locateRegion(doc, source) {
  if (source.region && validBox(source.region)) return { region: source.region, granularity: 'block', reason: '使用 MinerU 版面区域。' };
  if (source.paragraph && doc.extraction?.provider !== 'mineru') {
    const layout = await pageLayout(doc, source.page), part = layout.paragraphs.find(p => p.number === source.paragraph);
    const region = part?.located && unionBoxes(part.boxes);
    if (region && region.width * region.height < .6) return { region, granularity: 'line', reason: '使用唯一匹配的原文行坐标。' };
  }
  return { region: null, granularity: 'page', reason: '缺少可靠的局部坐标，使用原始整页；不绘制推测区域。' };
}
export async function renderRegionImage(doc, page, region, signal) {
  if (!doc.pdfBuffer || !Number.isInteger(page) || page < 1 || page > doc.pages.length) throw new Error('原始 PDF 或页码无效。');
  if (!validBox(region)) throw new Error('局部区域坐标无效。');
  signal?.throwIfAborted();
  const padded = unionBoxes([region], .015), key = hash([doc.contentFingerprint || doc.id, page, padded, REGION_RENDER_VERSION]);
  if (cache.has(key)) return cache.get(key);
  const directory = await mkdtemp(join(tmpdir(), 'paper-region-'));
  try {
    const path = join(directory, 'source.pdf'), prefix = join(directory, 'region');
    await writeFile(path, doc.pdfBuffer, { mode: 0o600 });
    const { stdout } = await exec(process.env.PDFINFO_PATH || 'pdfinfo', ['-f', String(page), '-l', String(page), '-box', path], { signal, timeout: 15000, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } });
    const size = /size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i.exec(stdout), rot = /rot:\s*(-?\d+)/i.exec(stdout);
    if (!size || !rot) throw new Error('无法确认 PDF 页面尺寸和旋转角度。');
    let width = Number(size[1]), height = Number(size[2]); if (Number(rot[1]) % 180) [width, height] = [height, width];
    const dpi = Math.min(400, 3200 * 72 / Math.max(width * padded.width, height * padded.height));
    const scale = dpi / 72, x = Math.floor(width * padded.x * scale), y = Math.floor(height * padded.y * scale);
    const w = Math.max(1, Math.ceil(width * (padded.x + padded.width) * scale) - x), h = Math.max(1, Math.ceil(height * (padded.y + padded.height) * scale) - y);
    await exec(process.env.PDFTOPPM_PATH || 'pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-r', String(dpi), '-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h), '-jpeg', '-jpegopt', 'quality=95', path, prefix], { signal, timeout: 45000, maxBuffer: 1048576 });
    const buffer = await readFile(`${prefix}.jpg`);
    // Bound memory; rendered crops can always be regenerated from the original.
    if (buffer.length < 8 * 1024 * 1024) { while ([...cache.values()].reduce((n, b) => n + b.length, 0) + buffer.length > 32 * 1024 * 1024 && cache.size) cache.delete(cache.keys().next().value); cache.set(key, buffer); }
    return buffer;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export function clearRegions() { cache.clear(); }
export async function regionInput(doc, source, signal) {
  const location = await locateRegion(doc, source), page = await renderPageImage(doc, source.page, signal);
  const content = imageContent([{ page: source.page, buffer: page }]);
  let crop = null;
  if (location.region) {
    try {
      crop = await renderRegionImage(doc, source.page, location.region, signal);
      content.push({ type: 'text', text: `下面是 [${source.ref}] 的局部高清区域（含少量边距），来自同一原始页面。整页用于判断上下文；局部用于辨认细节，不能把区域外内容当成已精读。` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${crop.toString('base64')}`, detail: 'high' } });
    } catch (error) { if (signal?.aborted) throw error; Object.assign(location, { region: null, granularity: 'page', reason: '局部高清渲染失败，明确降级为整页读取；未提供局部图。' }); }
  }
  return { content, location, bytes: page.length + (crop?.length || 0), imageCount: crop ? 2 : 1 };
}
