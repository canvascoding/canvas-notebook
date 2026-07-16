import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import {
  getEmbeddedKatexCss,
  renderMarkdownForPdf,
} from '../app/lib/pdf/markdown-renderer';

async function main() {
  const markdown = [
    '---',
    'title: Hidden export metadata',
    'tags: [type/report, status/final]',
    'aliases:',
    '  - Confidential draft',
    '---',
    '',
    '# Mathematical formulas',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    'Inline punctuation ($E$) and adjacent text $c^2$ remain supported.',
    '',
    'An escaped price costs \\$5 and inline code stays literal: `$notMath$`.',
    '',
    'Untrusted commands remain disabled: $\\href{javascript:alert(1)}{bad}$.',
  ].join('\n');
  const html = await renderMarkdownForPdf(markdown);

  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const document = dom.window.document;

  assert.equal(document.querySelectorAll('.katex-display').length, 1);
  assert.equal(document.querySelectorAll('.katex').length, 4);
  assert.doesNotMatch(
    document.body.textContent || '',
    /Hidden export metadata|type\/report|status\/final|Confidential draft/,
  );
  assert.equal(document.querySelector('hr'), null);
  assert.equal(document.querySelector('code')?.textContent, '$notMath$');
  assert.equal(document.querySelector('code .katex'), null);
  assert.match(document.body.textContent || '', /costs \$5/);
  assert.doesNotMatch(html, /href=["']javascript:/i);

  const katexCss = await getEmbeddedKatexCss();
  assert.match(katexCss, /\.katex\{/);
  assert.match(katexCss, /data:font\/woff2;base64,/);
  assert.doesNotMatch(katexCss, /url\(fonts\//);

  console.log('markdown-pdf-latex-export-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
