import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import * as marked from 'marked';
import katex from 'katex';
import 'katex/contrib/mhchem';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/init\(\);\s*$/, '');
const context = vm.createContext({ document: {}, crypto: {}, setTimeout, clearTimeout, console, marked, katex, DOMPurify: createDOMPurify(new JSDOM('').window) });
vm.runInContext(await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8'), context);
vm.runInContext(source, context);
const render = text => vm.runInContext(`renderMarkdown(${JSON.stringify(text)})`, context);

test('model output cannot insert script, event handlers or javascript links', () => {
  const html = render('<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[bad](javascript:alert(1))');
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script')); assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /&lt;script&gt;/);
});
test('quoted URLs are escaped and external links use noopener', () => {
  const html = render('[paper](https://example.com/"onmouseover="alert)');
  assert.match(html, /&quot;/); assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(!html.includes(' onmouseover="'));
});
test('tables, fenced code and citations render as safe, useful elements', () => {
  const html = render('# Results\n\n| Model | Evidence |\n| --- | --- |\n| A | **supported** [P2] |\n\n```html\n<script>bad()</script>\n```');
  assert.match(html, /<table>/); assert.match(html, /<strong>supported<\/strong>/);
  assert.match(html, /data-source-page="2"/); assert.match(html, /&lt;script&gt;bad/);
});
test('default numeric parameters satisfy their own constraints', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<input id="(temperature|maxTokens|contextBudget|analysisMaxTokens|analysisContextBudget)"[^>]+>/g)) {
    const attr = name => Number(new RegExp(`${name}="([^"]+)"`).exec(match[0])[1]);
    const [value, min, max, step] = ['value', 'min', 'max', 'step'].map(attr);
    assert.ok(value >= min && value <= max, match[1]);
    assert.ok(Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-9, match[1]);
  }
});

test('inline and multiline math render without Markdown corrupting subscripts, cases or matrices', () => {
  const html = render(String.raw`Inline \(x_i^2 + \frac{1}{n}\) and $\alpha_1$.

\[
\mathcal{L}=\sum_{i=1}^{n}\left\|x_i-y_i\right\|^2
\]

\begin{align}
a &= b+c \\
d &= \begin{cases}1 & x>0 \\ 0 & x\le0\end{cases}
\end{align}

$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`);
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.ok(!html.includes('math-fallback')); assert.match(html, /<math/); assert.match(html, /math-block/);
});

test('formulas in tables and LaTeX fences render, while ordinary code stays literal', () => {
  const html = render(String.raw`| Model | Formula |
| --- | --- |
| A | $x_i + \frac{1}{2}$ |

\`\`\`latex
\nabla_\theta \mathcal{L}
\`\`\`

\`\`\`python
print('$x_i$')
\`\`\`

\ce{H2O}`.replace(/\\`/g, '`'));
  assert.match(html, /<table>/); assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /print\(/); assert.match(html, /\$x_i\$/);
});

test('unsupported math preserves readable source and malicious TeX never adds executable HTML', () => {
  assert.match(render(String.raw`\[\notARealCommand{x}\]`), /math-fallback/);
  const html = render(String.raw`\(\href{javascript:alert(1)}{click}\) <img src=x onerror=alert(1)>`);
  assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('onerror="'));
});
test('vertical bars in table formulas remain inside the formula rather than splitting columns', () => {
  const html = render(String.raw`| Model | Formula |
| --- | --- |
| A | $P(a|b)$ and \(\left|x_i\right|\) |`);
  assert.equal((html.match(/<td>/g) || []).length, 2); assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.ok(!html.includes('math-fallback'));
});

test('MinerU source previews render formulas and tables while keeping source text untrusted', () => {
  const originalDocument = context.document;
  const dom = new JSDOM('<select id="sourcePageSelect"><option value="1">1</option></select><select id="sourceParagraphSelect"></select><button id="sourcePrev"></button><button id="sourceNext"></button><div id="sourceText"></div><div id="sourceImageWrap"></div><button id="sourceImageBtn"></button><button id="sourceUsePageBtn"></button><button id="sourceZoomBtn"></button><button id="sourceTextBtn"></button><img id="sourceImage"><p id="sourceImageStatus"></p>');
  context.document = dom.window.document;
  try {
    const paragraphs = [
      { number: 1, id: 'P1.1', text: String.raw`$$L=\frac{1}{N}\sum_i x_i^2$$` },
      { number: 2, id: 'P1.2', text: '| Method | Acc |\n| --- | --- |\n| A | 91% |' },
      { number: 3, id: 'P1.3', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' }
    ];
    vm.runInContext(`state.sourceDocument=${JSON.stringify({ visualAvailable: true, extraction: { provider: 'mineru' }, pages: [{ number: 1, paragraphs }] })};state.sourceView='text';state.sourceParagraph=null;renderSourcePage();`, context);
    const source = dom.window.document.getElementById('sourceText');
    assert.ok(source.querySelector('.katex')); assert.ok(source.querySelector('table'));
    assert.equal(source.querySelectorAll('.source-paragraph').length, 3);
    assert.equal(source.querySelectorAll('script,img').length, 0);
    assert.match(source.textContent, /alert\(1\)/);
  } finally { context.document = originalDocument; vm.runInContext('state.sourceDocument=null;', context); }
});
test('paragraph citations keep both page and paragraph locators, without changing math or code', () => {
  const html = render('Evidence [P3.2] and [S1.4]. `literal [P2.3]`');
  assert.match(html, /data-source-page="3"[^>]*data-source-paragraph="2"/);
  assert.match(html, /data-source-kind="S"[^>]*data-source-paragraph="4"/);
  assert.match(html, /<code>literal \[P2.3\]<\/code>/);
});

test('unfinished streamed math stays as exact source and renders after continuation closes it', () => {
  const partial=render('Formula:\n\n\\[x=\\frac{1');
  assert.match(partial,/math-pending/);assert.ok(partial.includes('\\[x=\\frac{1'));assert.ok(!partial.includes('class="katex"'));
  const complete=render('Formula:\n\n\\[x=\\frac{1}{2}\\]');assert.match(complete,/class="katex"/);assert.ok(!complete.includes('math-pending'));
  assert.match(render('```latex\nx^2'),/math-pending/);
});

test('verbatim JSON-escaped TeX from a real continuation renders without changing literal code', () => {
  const html=render(String.raw`Inline \\(x_i+\\frac{1}{2}\\).

\\[A=\\begin{cases}1&x>0\\\\0&x\\le0\\end{cases}\\]

\`\\(literal\\)\``.replace(/\\`/g,'`'));
  assert.equal((html.match(/class="katex"/g)||[]).length,2);
  assert.ok(!html.includes('math-fallback'));assert.match(html,/<code>\\\\\(literal/);
});

test('real model paragraph ranges become individual clickable citations while code stays literal',()=>{
 const html=render('Evidence [P4.8-P4.10], pages [P4–P6]; `literal [P4.8-P4.10]`.');
 assert.equal((html.match(/class="source-ref"/g)||[]).length,6);assert.match(html,/data-source-paragraph="9"/);assert.match(html,/<code>literal \[P4.8-P4.10\]<\/code>/);
 assert.ok(!render('[P1-P9999]').includes('source-ref'));
});
