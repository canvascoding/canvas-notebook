import assert from 'node:assert/strict';

import {
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
} from '../app/lib/workspaces/brand-profile';
import {
  createWorkspaceBrandCss,
  createWorkspaceBrandHeaderHtml,
  createWorkspaceBrandPdfHeaderTemplate,
  getMarkdownPdfRenderOptions,
  workspaceBrandFontStack,
} from '../app/lib/pdf/markdown-brand';

const corporate = cloneWorkspaceBrandProfile(WORKSPACE_BRAND_PRESETS.corporate);
corporate.brandName = '<Canvas & Studios>';
corporate.logoPath = 'assets/logo.png';
corporate.logoPosition = 'left';
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
assert.match(workspaceBrandFontStack('arial-sans'), /Liberation Sans/u);
assert.match(workspaceBrandFontStack('georgia-serif'), /Liberation Serif/u);
assert.match(workspaceBrandFontStack('courier-mono'), /Liberation Mono/u);

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

const logoDataUri = 'data:image/png;base64,AAAA';
const pdfHeader = createWorkspaceBrandPdfHeaderTemplate(corporate, logoDataUri);
assert.match(pdfHeader, /justify-content:flex-start/u);
assert.match(pdfHeader, /max-height:9mm/u);
assert.match(pdfHeader, /max-width:28mm/u);
assert.match(pdfHeader, /data:image\/png;base64,AAAA/u);
assert.equal(createWorkspaceBrandPdfHeaderTemplate(corporate, 'javascript:alert(1)'), '');

const disabled = cloneWorkspaceBrandProfile(corporate);
disabled.enabled = false;
assert.equal(createWorkspaceBrandHeaderHtml({
  profile: disabled,
  logoDataUri: 'data:image/png;base64,AAAA',
  escapeHtml: (value) => value,
}), '');

assert.deepEqual(getMarkdownPdfRenderOptions(corporate, logoDataUri), {
  format: 'Letter',
  preferCssPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: pdfHeader,
  footerTemplate: '<div></div>',
  margin: {
    top: '28mm',
    right: '18mm',
    bottom: '28mm',
    left: '18mm',
  },
});

corporate.page.verticalMarginMm = 10;
const compactCss = createWorkspaceBrandCss(corporate);
assert.match(compactCss, /margin: 18mm 18mm 10mm;/u);
assert.equal(getMarkdownPdfRenderOptions(corporate, null).displayHeaderFooter, undefined);

console.log('workspace-brand-pdf-test: ok');
