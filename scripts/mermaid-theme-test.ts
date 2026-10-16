import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  CANVAS_MERMAID_DARK,
  CANVAS_MERMAID_LIGHT,
  createMermaidTheme,
  createMermaidExportTheme,
} from '../app/lib/markdown/mermaid-theme';
import { DEFAULT_WORKSPACE_BRAND_PROFILE } from '../app/lib/workspaces/brand-profile';
import { workspaceAppearanceContrastRatio } from '../app/lib/workspaces/appearance-theme';

async function main() {
  for (const tokens of [CANVAS_MERMAID_LIGHT, CANVAS_MERMAID_DARK]) {
    const theme = createMermaidTheme(tokens);
    assert.equal(theme.theme, 'base');
    assert.equal(theme.securityLevel, 'strict');
    const variables = theme.themeVariables!;
    assert.ok(workspaceAppearanceContrastRatio(variables.textColor, tokens.background) >= 4.5);
    for (const color of variables.xyChart.plotColorPalette.split(', ')) {
      assert.ok(workspaceAppearanceContrastRatio(color, tokens.background) >= 4.5);
    }
  }
  const lowContrast = createMermaidTheme({ ...CANVAS_MERMAID_LIGHT,
    foreground: '#eeeeee', muted: '#ffffff', charts: ['#eeeeee'] });
  assert.ok(workspaceAppearanceContrastRatio(lowContrast.themeVariables!.textColor, CANVAS_MERMAID_LIGHT.background) >= 4.5);
  assert.equal(createMermaidTheme(CANVAS_MERMAID_DARK).themeVariables!.darkMode, true);
  const brand = structuredClone(DEFAULT_WORKSPACE_BRAND_PROFILE);
  brand.colors.accent = '#81339a';
  brand.typography.bodyFont = 'georgia-serif';
  const branded = createMermaidExportTheme(brand);
  assert.match(branded.fontFamily!, /Georgia/);
  assert.ok(branded.themeVariables!.xyChart.plotColorPalette.startsWith('#81339a'));

  const keys = ['CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB', 'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = '0';
  const { renderMermaidToSvg, markdownTextToHtmlDocument } = await import('../app/lib/pdf/markdown-to-html');
  const { disposePdfBrowser } = await import('../app/lib/pdf/browser');
  const chart = 'xychart-beta\n x-axis [Desktop, Mobile]\n bar [44, 99]\n line [176, 447]';
  try {
    for (const tokens of [CANVAS_MERMAID_LIGHT, CANVAS_MERMAID_DARK]) {
      const svg = await renderMermaidToSvg(chart, createMermaidTheme(tokens));
      assert.ok(svg);
      assert.ok(svg.includes(tokens.background), 'standalone SVG must carry its background color');
      const dom = new JSDOM(svg);
      const bars = [...dom.window.document.querySelectorAll('.bar-plot-0 rect')];
      assert.equal(bars.length, 2);
      assert.equal(bars[0].getAttribute('fill'), createMermaidTheme(tokens).themeVariables!.xyChart.plotColorPalette.split(', ')[0]);
      dom.window.close();
    }
    const html = await markdownTextToHtmlDocument('```mermaid\n'+chart+'\n```', { brandProfile: brand });
    assert.match(html, /fill="#81339a"/);
    assert.doesNotMatch(html, /mermaid-diagram-fallback" style/);
    const custom = await renderMermaidToSvg('---\nconfig:\n  themeVariables:\n    xyChart:\n      plotColorPalette: "#af1234, #345678"\n---\n'+chart);
    assert.ok(custom?.includes('fill="#af1234"'), 'explicit document colors must remain available');
  } finally {
    await disposePdfBrowser('Mermaid theme test complete');
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
  console.log('mermaid-theme-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
