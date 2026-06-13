import assert from 'node:assert/strict';

import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '../app/lib/email/html-content';

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

console.log('Email HTML content normalization test passed.');
