import assert from 'node:assert/strict';

import {
  createMarkdownPaperPreviewDocument,
  getMarkdownPaperLayout,
} from '../app/components/file-browser/MarkdownPaperPreview';

const brandedDocument = `<!doctype html>
<html><head><style>
  @page { size: A4; margin: 20mm 16mm; }
  @page { size: Letter; margin: 18mm 14mm 10mm; }
</style></head><body><h1>Delivery draft</h1></body></html>`;

assert.deepEqual(getMarkdownPaperLayout(brandedDocument), {
  size: 'Letter',
  widthMm: 215.9,
  heightMm: 279.4,
  marginTopMm: 18,
  marginRightMm: 14,
  marginBottomMm: 10,
  marginLeftMm: 14,
});

assert.deepEqual(getMarkdownPaperLayout('<style>@page { size: A4; margin: 12mm; }</style>'), {
  size: 'A4',
  widthMm: 210,
  heightMm: 297,
  marginTopMm: 12,
  marginRightMm: 12,
  marginBottomMm: 12,
  marginLeftMm: 12,
});

const previewDocument = createMarkdownPaperPreviewDocument(brandedDocument);
assert.match(previewDocument, /data-canvas-paper-preview="true"/u);
assert.match(previewDocument, /script-src 'none'/u);
assert.match(previewDocument, /canvas-paper-preview-page/u);
assert.match(previewDocument, /white-space: pre-wrap/u);
assert.match(previewDocument, /content: " \(" attr\(href\) "\)"/u);

console.log('markdown-paper-preview-test: ok');
