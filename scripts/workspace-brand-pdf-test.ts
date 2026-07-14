import assert from 'node:assert/strict';

import {
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
} from '../app/lib/workspaces/brand-profile';
import {
  createWorkspaceBrandCss,
  createWorkspaceBrandHeaderHtml,
  getMarkdownPdfRenderOptions,
} from '../app/lib/pdf/markdown-brand';

const corporate = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.corporate);
corporate.brandName = '<Canvas & Studios>';
corporate.logoPath = 'assets/logo.png';
corporate.page.size = 'Letter';
corporate.page.backgroundColor = '#fefcf7';
corporate.page.verticalMarginMm = 28;
corporate.page.horizontalMarginMm = 18;
corporate.typography.h1Style = 'accent-bar';

const css = createWorkspaceBrandCss(corporate);
assert.match(css, /size: Letter;/u);
assert.match(css, /margin: 28mm 18mm;/u);
assert.match(css, /background: #fefcf7;/u);
assert.match(css, /border-left: 4px solid #0f6cbd;/u);
assert.match(css, /Avenir Next/u);

const header = createWorkspaceBrandHeaderHtml({
  profile: corporate,
  logoDataUri: 'data:image/png;base64,AAAA',
  escapeHtml: (value) => value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;'),
});
assert.match(header, /canvas-brand-logo/u);
assert.match(header, /&lt;Canvas &amp; Studios&gt;/u);
assert.doesNotMatch(header, /<Canvas/u);

const disabled = cloneWorkspaceBrandProfile(corporate);
disabled.enabled = false;
assert.equal(createWorkspaceBrandHeaderHtml({
  profile: disabled,
  logoDataUri: 'data:image/png;base64,AAAA',
  escapeHtml: (value) => value,
}), '');

assert.deepEqual(getMarkdownPdfRenderOptions(corporate), {
  format: 'Letter',
  preferCssPageSize: true,
});

console.log('workspace-brand-pdf-test: ok');
