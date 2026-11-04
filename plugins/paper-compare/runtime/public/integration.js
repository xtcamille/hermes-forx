'use strict';
(() => {
  const expected = document.querySelector('meta[name="paper-parent-origin"]')?.content;
  if (!expected || window.parent === window) return;
  const origin = expected === 'file:' ? 'null' : expected;
  const tokens = { background: '--bg', card: '--paper', foreground: '--ink', mutedForeground: '--muted',
    secondaryForeground: '--subtle', border: '--line', primary: '--accent', primaryForeground: '--forx-primary-ink', ring: '--accent-hover' };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== origin || event.data?.type !== 'paper-compare:appearance') return;
    const { colors, mode } = event.data;
    if (!colors || !['light', 'dark'].includes(mode)) return;
    const root = document.documentElement;
    for (const [key, variable] of Object.entries(tokens)) {
      const value = colors[key];
      if (typeof value === 'string' && value.length < 160 && window.CSS?.supports('color', value)) {
        root.style.setProperty(variable, value);
        if (key === 'primary') root.style.setProperty('--teal', value);
      }
    }
    root.dataset.forxTheme = mode;
    root.style.colorScheme = mode;
  });
  window.parent.postMessage({ type: 'paper-compare:ready' }, origin === 'null' ? '*' : origin);
})();
