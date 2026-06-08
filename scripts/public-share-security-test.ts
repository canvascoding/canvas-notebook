import assert from 'node:assert/strict';

import {
  INTERACTIVE_PUBLIC_HTML_CSP,
  normalizePublicShareSecurityMode,
  resolvePublicHtmlSiteAssetWorkspacePath,
  STRICT_PUBLIC_HTML_CSP,
} from '../app/lib/public-sharing/public-share-security';

assert.equal(normalizePublicShareSecurityMode('interactive'), 'interactive');
assert.equal(normalizePublicShareSecurityMode('anything-else'), 'strict');

assert.match(STRICT_PUBLIC_HTML_CSP, /script-src 'none'/);
assert.match(INTERACTIVE_PUBLIC_HTML_CSP, /sandbox allow-scripts/);
assert.doesNotMatch(
  INTERACTIVE_PUBLIC_HTML_CSP,
  /allow-same-origin/,
  'Interactive public HTML must not run as the app origin'
);

assert.equal(
  resolvePublicHtmlSiteAssetWorkspacePath('sites/demo/index.html', ['index.html']),
  'sites/demo/index.html'
);
assert.equal(
  resolvePublicHtmlSiteAssetWorkspacePath('sites/demo/index.html', ['app.js']),
  'sites/demo/app.js'
);
assert.equal(
  resolvePublicHtmlSiteAssetWorkspacePath('sites/demo/index.html', ['assets', 'chart.js']),
  'sites/demo/assets/chart.js'
);
assert.equal(
  resolvePublicHtmlSiteAssetWorkspacePath('sites/demo/index.html', ['..', 'secret.txt']),
  null
);
assert.equal(
  resolvePublicHtmlSiteAssetWorkspacePath('../outside/index.html', ['app.js']),
  null
);

console.log('Public share security helper test passed');
