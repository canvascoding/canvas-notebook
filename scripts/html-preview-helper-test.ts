import assert from 'node:assert/strict';
import {
  createHtmlPreviewBaseHref,
  createHtmlPreviewDocument,
  getHtmlPreviewAssetContentType,
  HTML_PREVIEW_CSP,
} from '../app/lib/html-preview';

const dashboardHtml = '<!doctype html><html><head><title>Dashboard</title></head><body><img src="chart.png"><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></body></html>';
const previewDocument = createHtmlPreviewDocument(dashboardHtml, 'reports/q2/dashboard.html', '/api/media/preview');

assert.match(
  previewDocument,
  /<head>\n  <base href="\/api\/media\/preview\/reports\/q2\/">/,
  'HTML preview should inject a base URL for relative assets'
);
assert.match(
  HTML_PREVIEW_CSP,
  /script-src[^;]+https:/,
  'HTML preview CSP should allow trusted-file previews to load CDN chart libraries'
);
assert.equal(
  createHtmlPreviewBaseHref('/api/studio/media/preview', 'studio/outputs/a b/index.html'),
  '/api/studio/media/preview/studio/outputs/a%20b/',
  'Base URL should encode path segments'
);
assert.equal(getHtmlPreviewAssetContentType('chart.js'), 'text/javascript; charset=utf-8');
assert.equal(getHtmlPreviewAssetContentType('styles/site.css'), 'text/css; charset=utf-8');
assert.equal(getHtmlPreviewAssetContentType('images/chart.png'), 'image/png');

const htmlWithBase = '<html><head><base href="/custom/"><title>Keep base</title></head><body></body></html>';
assert.equal(
  createHtmlPreviewDocument(htmlWithBase, 'dashboard.html', '/api/media/preview'),
  htmlWithBase,
  'Existing base tags should be preserved'
);

console.log('HTML preview helper test passed');
