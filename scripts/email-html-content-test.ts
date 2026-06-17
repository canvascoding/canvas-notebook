import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '../app/lib/email/html-content';

const dom = new JSDOM('<!doctype html><html><body></body></html>');

for (const key of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}

const htmlDocument = '<!doctype html><html><body><p>Hello</p></body></html>';
const fencedHtmlDocument = `\`\`\`html
${htmlDocument}
\`\`\``;
const doubleTickHtmlDocument = `\`\`
${htmlDocument}`;

assert.equal(isLikelyHtmlEmailContent(htmlDocument), true);
assert.equal(isLikelyHtmlEmailContent(fencedHtmlDocument), true);
assert.equal(isLikelyHtmlEmailContent(doubleTickHtmlDocument), true);
assert.equal(normalizeEmailHtmlContent(fencedHtmlDocument), htmlDocument);
assert.equal(normalizeEmailHtmlContent(doubleTickHtmlDocument), htmlDocument);

assert.equal(isLikelyHtmlEmailContent('Use `<div>` in a code example.'), false);
assert.equal(normalizeEmailHtmlContent('Use `<div>` in a code example.'), 'Use `<div>` in a code example.');

async function main() {
  const { sanitizeEmailEditorHtml } = await import('../app/lib/email/html-editor-content');

  const sanitizedTable = sanitizeEmailEditorHtml(`
    <table border="1" cellpadding="6" cellspacing="0">
      <thead>
        <tr><th style="text-align: center" onclick="alert(1)">Name</th><th>Qty</th></tr>
      </thead>
      <tbody>
        <tr><td style="text-align: right">Canvas</td><td><script>alert(1)</script>2</td></tr>
      </tbody>
    </table>
  `);

  assert.match(sanitizedTable, /<table[^>]*border="1"[^>]*cellpadding="6"[^>]*cellspacing="0"/u);
  assert.match(sanitizedTable, /<th[^>]*align="center"[^>]*>Name<\/th>/u);
  assert.match(sanitizedTable, /<td[^>]*align="right"[^>]*>Canvas<\/td>/u);
  assert.doesNotMatch(sanitizedTable, /style=|onclick=|<script/iu);

  assert.equal(
    sanitizeEmailEditorHtml('<p><a href="javascript:alert(1)" target="_blank">bad</a> <a href="https://example.com">ok</a></p>'),
    '<p><a target="_blank">bad</a> <a href="https://example.com">ok</a></p>',
  );

  assert.equal(
    sanitizeEmailEditorHtml('<p><img src="cid:hero-image" width="320" onerror="alert(1)"> <img src="https://example.com/hero.png" title="Hero"></p>'),
    '<p><img src="cid:hero-image" width="320"> <img src="https://example.com/hero.png" title="Hero"></p>',
  );
  assert.equal(sanitizeEmailEditorHtml('<p><img src="file:///etc/passwd"> <img src="javascript:alert(1)"></p>'), '<p> </p>');
  assert.equal(sanitizeEmailEditorHtml('<p><img src="data:image/png;base64,abcd" alt="Bad"></p>'), '<p></p>');

  console.log('Email HTML content normalization test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
