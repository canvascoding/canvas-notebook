import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  WORKSPACE_BRAND_PRESETS,
  cloneWorkspaceBrandProfile,
} from '../app/lib/workspaces/brand-profile';
import {
  createWorkspaceBrandCss,
  createWorkspaceBrandHeaderHtml,
  createWorkspaceBrandPdfHeaderTemplate,
  getMarkdownPdfRenderOptions,
  hideBodyBrandHeaderForRepeatingPdfHeader,
  resolveWorkspaceBrandPdfHeaderName,
} from '../app/lib/pdf/markdown-brand';
import {
  workspaceBrandFontStack,
  workspaceBrandUiFontStack,
} from '../app/lib/workspaces/brand-fonts';

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
assert.match(css, /--brand-radius: 4px;/u);
assert.match(css, /pre \{[\s\S]*?border-radius: var\(--brand-radius\);/u);
assert.match(css, /Avenir Next/u);
assert.match(workspaceBrandFontStack('arial-sans'), /Liberation Sans/u);
assert.match(workspaceBrandFontStack('georgia-serif'), /Liberation Serif/u);
assert.match(workspaceBrandFontStack('courier-mono'), /Liberation Mono/u);
assert.match(workspaceBrandUiFontStack('canvas-sans'), /--font-geist-sans/u);
assert.equal(workspaceBrandUiFontStack('editorial-serif'), workspaceBrandFontStack('editorial-serif'));

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
assert.match(pdfHeader, /&lt;Canvas &amp; Studios&gt;/u);
assert.ok(
  pdfHeader.indexOf('<img') < pdfHeader.indexOf('<span'),
  'left-positioned PDF branding should render the name to the right of the logo',
);
assert.equal(createWorkspaceBrandPdfHeaderTemplate(corporate, 'javascript:alert(1)'), '');

const rightAligned = cloneWorkspaceBrandProfile(corporate);
rightAligned.logoPosition = 'right';
const rightPdfHeader = createWorkspaceBrandPdfHeaderTemplate(rightAligned, logoDataUri);
assert.match(rightPdfHeader, /justify-content:flex-end/u);
assert.ok(
  rightPdfHeader.indexOf('<span') < rightPdfHeader.indexOf('<img'),
  'right-positioned PDF branding should render the name to the left of the logo',
);

const workspaceFallback = cloneWorkspaceBrandProfile(rightAligned);
workspaceFallback.brandName = '';
assert.equal(resolveWorkspaceBrandPdfHeaderName(workspaceFallback, ' Product Workspace '), 'Product Workspace');
assert.match(
  createWorkspaceBrandPdfHeaderTemplate(workspaceFallback, logoDataUri, 'Product Workspace'),
  />Product Workspace<\/span>/u,
);

const bodyHeaderHtml = '<html><head></head><body><header class="canvas-brand-header">Duplicate</header></body></html>';
const preparedPdfHtml = hideBodyBrandHeaderForRepeatingPdfHeader(bodyHeaderHtml);
assert.match(preparedPdfHtml, /body > \.canvas-brand-header\{display:none!important;\}/u);
assert.equal(preparedPdfHtml.match(/Duplicate/gu)?.length, 1);

const brandSettingsPanelSource = readFileSync(
  path.join(process.cwd(), 'app/components/settings/BrandSettingsPanel.tsx'),
  'utf8',
);
assert.match(
  brandSettingsPanelSource,
  /hasBrandLogo && profile\.logoPosition === 'right' && 'flex-row-reverse'/u,
  'The PDF preview must mirror the logo/name order for right-aligned branding.',
);
assert.match(
  brandSettingsPanelSource,
  /brandName=\{profile\.brandName\.trim\(\) \|\| selectedWorkspace\.name\}/u,
  'The PDF preview must fall back to the configured workspace name.',
);

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
