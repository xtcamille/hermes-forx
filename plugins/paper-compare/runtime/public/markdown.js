'use strict';

// KaTeX, Marked and DOMPurify are served locally. No model output is executed.
(() => {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const environments = 'equation\\*?|align\\*?|alignat\\*?|gather\\*?|multline\\*?|displaymath|aligned|gathered|cases|[pbvBV]?matrix';
  const environment = new RegExp(`^\\\\begin\\{(${environments})\\}[\\s\\S]*?\\\\end\\{\\1\\}`);
  function matchMath(src, block) {
    // Some gateways return JSON-escaped TeX verbatim. Normalize only inside
    // explicit doubled delimiters; literal code and ordinary TeX stay intact.
    const doubled = (block ? /^\\\\\[([\s\S]*?)\\\\\]/ : /^\\\\\(([\s\S]*?)\\\\\)/).exec(src);
    if (doubled) return { raw: doubled[0], text: doubled[1].replace(/\\\\/g, '\\'), display: block };
    if (block) {
      const match = /^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])/.exec(src);
      if (match) return { raw: match[0], text: match[1] ?? match[2], display: true };
      const env = environment.exec(src);
      if (env) {
        let text = env[0];
        // KaTeX uses aligned for a single multiline equation.
        if (/^multline/.test(env[1])) text = text.replace(/\{multline\*?\}/g, '{aligned}');
        return { raw: env[0], text, display: true };
      }
      if (/^(?:\$\$|\\\[|\\begin\{(?:equation|align|gather|multline|displaymath|aligned|cases|[pbvBV]?matrix))/.test(src)) return { raw: src, text: src, display: true, unfinished: true };
    } else {
      const match = /^(?:\\\(([\s\S]*?)\\\)|\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\$))/.exec(src);
      if (match && (match[1] !== undefined || match[2].trim() === match[2])) return { raw: match[0], text: match[1] ?? match[2], display: false };
      if (/^\\\(/.test(src) && !src.includes('\\)')) return { raw: src, text: src, display: false, unfinished: true };
    }
    return null;
  }
  function mathHtml(text, display) {
    try {
      const html = katex.renderToString(text.trim(), { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml', macros: { '\\RR': '\\mathbb{R}', '\\EE': '\\mathbb{E}', '\\argmin': '\\operatorname*{arg\\,min}', '\\argmax': '\\operatorname*{arg\\,max}' } });
      return display ? `<div class="math-block">${html}</div>\n` : html;
    } catch {
      return `<${display ? 'div' : 'span'} class="math-fallback" title="公式语法或命令暂不支持，保留 LaTeX 原文">${escape(text)}</${display ? 'div' : 'span'}>`;
    }
  }
  const parser = new marked.Marked({ gfm: true, breaks: true });
  const citationHtml = (kind, page, paragraph = '') => `<button class="source-ref" type="button" data-source-page="${page}" data-source-kind="${kind}" data-source-paragraph="${paragraph}" aria-label="查看原文 ${kind}${page}${paragraph ? `第${paragraph}段` : ''}">${kind}${page}${paragraph ? `.${paragraph}` : ''}</button>`;
  let tableMath = [];
  parser.use({ extensions: [
    { name: 'citationRange', level: 'inline', start: src => src.search(/\[[PS]\d/), tokenizer(src) {
      const m = /^\[([PS])(\d{1,5})(?:\.(\d{1,4}))?\s*[-–—]\s*\1(\d{1,5})(?:\.(\d{1,4}))?\]/.exec(src);
      if (!m) return;
      const paragraphs = m[3] && m[5] && m[2] === m[4], pages = !m[3] && !m[5];
      const start = Number(paragraphs ? m[3] : m[2]), end = Number(paragraphs ? m[5] : m[4]);
      if ((!paragraphs && !pages) || end < start || end - start > 24) return;
      return { type:'citationRange', raw:m[0], kind:m[1], page:m[2], paragraphs, start, end };
    }, renderer(t) { return Array.from({length:t.end-t.start+1},(_,i) => citationHtml(t.kind,t.paragraphs?t.page:t.start+i,t.paragraphs?t.start+i:'')).join(' '); } },
    { name: 'tableMath', level: 'inline', start: src => src.indexOf('\uE000MATH_'), tokenizer(src) { const match = /^\uE000MATH_(\d+)\uE001/.exec(src); if (match && tableMath[Number(match[1])]) return { type: 'tableMath', raw: match[0], text: tableMath[Number(match[1])] }; }, renderer(token) { return mathHtml(token.text, false); } },
    { name: 'displayMath', level: 'block', start: src => src.search(/\$\$|\\\\?\[|\\begin\{/), tokenizer(src) { const math = matchMath(src, true); if (math) return { type: 'displayMath', ...math }; }, renderer(token) { return token.unfinished ? `<pre class="math-pending" title="公式尚未结束，保留源码"><code>${escape(token.raw)}</code></pre>` : mathHtml(token.text, true); } },
    { name: 'inlineMath', level: 'inline', start: src => src.search(/\$(?!\$)|\\\\?\(/), tokenizer(src) { const math = matchMath(src, false); if (math) return { type: 'inlineMath', ...math }; }, renderer(token) { return token.unfinished ? `<code class="math-pending">${escape(token.raw)}</code>` : mathHtml(token.text, false); } },
    { name: 'citation', level: 'inline', start: src => src.search(/\[[PS]\d{1,5}(?:\.\d{1,4})?\]/), tokenizer(src) { const match = /^\[([PS])(\d{1,5})(?:\.(\d{1,4}))?\]/.exec(src); if (match) return { type: 'citation', raw: match[0], kind: match[1], page: match[2], paragraph: match[3] || '' }; }, renderer(token) { return `<button class="source-ref" type="button" data-source-page="${token.page}" data-source-kind="${token.kind}" data-source-paragraph="${token.paragraph}" aria-label="查看原文 ${token.kind}${token.page}${token.paragraph ? `第${token.paragraph}段` : ''}">${token.kind}${token.page}${token.paragraph ? `.${token.paragraph}` : ''}</button>`; } },
  ], renderer: {
    html(token) { return escape(token.text); },
    image(token) { return escape(token.text || '图片'); },
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      if (!/^https?:\/\//i.test(token.href)) return label;
      return `<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    code(token) {
      if (/^(?:latex|tex|math)$/i.test(token.lang?.trim()) && !/\n\s*(?:```|~~~)\s*$/.test(token.raw.trimEnd())) return `<pre class="math-pending"><code>${escape(token.text)}</code></pre>\n`;
      if (/^(?:latex|tex|math)$/i.test(token.lang?.trim())) return mathHtml(token.text.replace(/^\s*(?:\$\$|\\\[)|(?:\$\$|\\\])\s*$/g, ''), true);
      return `<pre><code>${escape(token.text)}</code></pre>\n`;
    },
  } });
  globalThis.PaperMarkdown = {
    render(text) {
      tableMath = []; let inFence = false;
      const source = String(text || '').replace(/[\uE000\uE001]/g, '').split('\n').map(line => {
        if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
        if (inFence || !line.includes('|')) return line;
        return line.replace(/`[^`]*`|\\\([\s\S]*?\\\)|\$(?!\$)(?:\\.|[^\\$\n])+?\$(?!\$)/g, match => {
          if (match.startsWith('`') || !match.includes('|')) return match;
          const math = matchMath(match, false); if (!math) return match;
          tableMath.push(math.text); return `\uE000MATH_${tableMath.length - 1}\uE001`;
        });
      }).join('\n');
      const safe = DOMPurify.sanitize(parser.parse(source), { ADD_TAGS: ['annotation'], ADD_ATTR: ['target', 'encoding'], FORBID_TAGS: ['img', 'style', 'iframe', 'object', 'embed', 'form', 'input'], FORBID_ATTR: ['id', 'name'] });
      return safe.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>');
    },
  };
})();
