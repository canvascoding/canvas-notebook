import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { JSDOM } from 'jsdom';

async function withServerOnlyModuleMock(run: () => Promise<void>): Promise<void> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    await run();
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function withBrowserExportTestEnv(run: () => Promise<void>): Promise<void> {
  const keys = [
    'CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB',
    'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU',
  ] as const;
  const original = new Map<string, string | undefined>();
  for (const key of keys) original.set(key, process.env[key]);

  try {
    process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
    process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const markdown = [
    '# Rich Markdown PDF export',
    '',
    '> [!warning] Important export note',
    '> The callout **content** must remain visible.',
    '',
    '<details>',
    '<summary>Closed in the editor</summary>',
    'This content is normally collapsible, but is **always expanded** in the PDF.',
    '</details>',
    '',
    'Inline formula $E = mc^2$ and a reference[^source].',
    '',
    '| Function | Result |',
    '| --- | --- |',
    '| Table cell | Editable content |',
    '',
    '[^source]: Footnote **content** is visible in the PDF.',
  ].join('\n');

  await withServerOnlyModuleMock(async () => {
    const { renderMarkdownForPdf } = await import('../app/lib/pdf/markdown-renderer');
    const { markdownTextToHtmlDocument } = await import('../app/lib/pdf/markdown-to-html');
    const { disposePdfBrowser, generatePdfFromHtml } = await import('../app/lib/pdf/browser');

    try {
      const fragment = await renderMarkdownForPdf(markdown);
      const dom = new JSDOM(`<!doctype html><html><body>${fragment}</body></html>`);
      const document = dom.window.document;

      const callout = document.querySelector('.canvas-pdf-callout-warning');
      assert.ok(callout, 'callouts should use their dedicated PDF representation');
      assert.match(callout.textContent || '', /Important export note/);
      assert.equal(callout.querySelector('strong')?.textContent, 'content');

      const details = document.querySelector('.canvas-pdf-details[data-expanded="true"]');
      assert.ok(details, 'collapsible sections should become expanded PDF sections');
      assert.equal(document.querySelector('details'), null, 'PDF output must not retain a collapsible details element');
      assert.match(details.textContent || '', /always expanded/);
      assert.equal(details.querySelector('strong')?.textContent, 'always expanded');

      const footnoteReference = document.querySelector('.canvas-pdf-footnote-reference a');
      assert.equal(footnoteReference?.getAttribute('href'), '#canvas-pdf-footnote-source');
      const footnote = document.querySelector('#canvas-pdf-footnote-source');
      assert.ok(footnote, 'footnote definitions should have a PDF anchor');
      assert.equal(footnote.querySelector('strong')?.textContent, 'content');

      assert.equal(document.querySelectorAll('.katex').length, 1, 'inline formulas should use KaTeX');
      assert.equal(document.querySelector('table td')?.textContent, 'Table cell');

      const html = await markdownTextToHtmlDocument(markdown, { title: 'Rich block export' });
      assert.match(html, /\.canvas-pdf-details-content\s*\{\s*display:\s*block/u);
      assert.match(html, /\.canvas-pdf-footnote-definition/u);
      assert.doesNotMatch(html, /<details(?:\s|>)/iu);

      await withBrowserExportTestEnv(async () => {
        const pdf = await generatePdfFromHtml(html);
        assert.match(pdf.subarray(0, 4).toString('ascii'), /^%PDF/u);

        const pdfPath = path.join(os.tmpdir(), 'canvas-notebook-rich-blocks-export-test.pdf');
        await fs.writeFile(pdfPath, pdf);
        console.log(`markdown-pdf-rich-blocks-export-test: PDF written to ${pdfPath}`);
      });
    } finally {
      await disposePdfBrowser('rich Markdown PDF export test complete');
    }
  });

  console.log('markdown-pdf-rich-blocks-export-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
