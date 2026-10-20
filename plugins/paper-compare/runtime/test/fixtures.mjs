export function samplePdf(pages = ['Paper Compare PDF extraction test. Methods and results are readable.']) {
  return layoutPdf(pages.map(text => ({ lines: [{ x: 50, y: 740, text }] })));
}

export function layoutPdf(pages) {
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const pageRefs = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages.length; index++) {
    const contentId = 5 + index * 2;
    const page = pages[index];
    const content = (page.lines || []).map(line => `BT /F1 12 Tf ${line.x} ${line.y} Td (${line.text.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width || 612} ${page.height || 792}] /Rotate ${page.rotate || 0} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
