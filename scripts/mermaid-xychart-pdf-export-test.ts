import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function checkXyChartPdfExport() {
  const envKeys = ['CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB', 'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU'] as const;
  const previous = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = '0';
  const { markdownTextToHtmlDocument, renderMermaidToSvg } = await import('../app/lib/pdf/markdown-to-html');
  const { disposePdfBrowser, generatePdfFromHtml } = await import('../app/lib/pdf/browser');
  try {
    const chart = `xychart-beta
    title "Geräte – Sessions vs. Seitenaufrufe"
    x-axis ["Desktop", "Mobile"]
    y-axis "Anzahl" 0 --> 500
    bar [44, 99]
    line [176, 447]`;
    const markdown = ['# Geräte', '', '```mermaid', chart, '```', '', '```mermaid',
      'flowchart LR\n A[Start] --> B[Export PDF]', '```'].join('\n');
    const html = await markdownTextToHtmlDocument(markdown, { title: 'XY chart export' });
    const dom = new JSDOM(html);
    try {
      assert.equal(dom.window.document.querySelectorAll('.mermaid-diagram > svg').length, 2);
      assert.equal(dom.window.document.querySelector('.mermaid-diagram-fallback'), null);
      const chartSvg = dom.window.document.querySelector('.mermaid-diagram > svg');
      assert.match(chartSvg?.textContent ?? '', /Geräte.*Sessions vs\. Seitenaufrufe/u);
      assert.match(chartSvg?.textContent ?? '', /Desktop/u);
      assert.match(chartSvg?.textContent ?? '', /Mobile/u);
      const pdf = await generatePdfFromHtml(html);
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.length > 1_000);
      const invalidStarted = performance.now();
      assert.equal(await renderMermaidToSvg('xychart-beta\n invalid chart syntax'), null);
      assert.ok(performance.now() - invalidStarted < 8_000,
        'a rejected diagram must not spend ten seconds waiting for an SVG that will never exist');
      const mixedHtml = await markdownTextToHtmlDocument([
        '```mermaid', 'invalid chart syntax', '```', '', '```mermaid', chart, '```',
      ].join('\n'));
      const mixed = new JSDOM(mixedHtml);
      assert.equal(mixed.window.document.querySelectorAll('.mermaid-diagram-fallback').length, 1);
      assert.equal(mixed.window.document.querySelectorAll('.mermaid-diagram > svg').length, 1,
        'an invalid diagram must not prevent later valid charts from exporting');
      mixed.window.close();
      const htmlLikeLabel = await renderMermaidToSvg('flowchart LR\n A["Safe </script> label"]');
      assert.ok(htmlLikeLabel, 'HTML script delimiters in diagram text must remain data');
      assert.doesNotMatch(htmlLikeLabel, /<script\b/iu);
    } finally {
      dom.window.close();
    }
  } finally {
    await disposePdfBrowser('XY chart PDF export test complete');
    for (let index = 0; index < envKeys.length; index++) {
      if (previous[index] === undefined) delete process.env[envKeys[index]];
      else process.env[envKeys[index]] = previous[index];
    }
  }
  console.log('mermaid-xychart-pdf-export-test: ok');
}

checkXyChartPdfExport().catch((error) => { console.error(error); process.exitCode = 1; });
