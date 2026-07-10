import assert from 'node:assert/strict';
import Module from 'node:module';

type MarkdownToHtmlModule = typeof import('../app/lib/pdf/markdown-to-html');

async function importMarkdownToHtml(): Promise<MarkdownToHtmlModule> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/pdf/markdown-to-html');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function withBrowserExportTestEnv(run: () => Promise<void>) {
  const keys = [
    'CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB',
    'CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU',
  ] as const;
  const original = new Map<string, string | undefined>();
  for (const key of keys) {
    original.set(key, process.env[key]);
  }

  try {
    process.env.CANVAS_BROWSER_EXPORT_MIN_FREE_MEMORY_MB = '0';
    process.env.CANVAS_BROWSER_EXPORT_MAX_LOAD_PER_CPU = '0';
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function main() {
  const { renderMermaidToSvg } = await importMarkdownToHtml();
  await withBrowserExportTestEnv(async () => {
    const svg = await renderMermaidToSvg(`flowchart LR
      A[Start] --> B{Ready?}
      B -->|Yes| C[Export PDF]
      B -->|No| A`);

    assert.ok(svg, 'a valid Mermaid flowchart should render for PDF export');
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /Start/);
    assert.match(svg, /Export PDF/);

    const untrustedSvg = await renderMermaidToSvg(`flowchart LR
      A[Safe]
      click A href "javascript:alert(1)"`);

    assert.ok(untrustedSvg, 'Mermaid should still render a diagram containing an unsafe link');
    assert.doesNotMatch(untrustedSvg, /javascript:/i);
    assert.doesNotMatch(untrustedSvg, /on[a-z]+\s*=/i);
    assert.doesNotMatch(untrustedSvg, /<script\b/i);
  });

  const { disposePdfBrowser } = await import('../app/lib/pdf/browser');
  await disposePdfBrowser('mermaid PDF export test complete');
  console.log('mermaid-pdf-export-test: ok');
}

main().catch(async (error) => {
  console.error(error);
  try {
    const { disposePdfBrowser } = await import('../app/lib/pdf/browser');
    await disposePdfBrowser('mermaid PDF export test failed');
  } catch {
    // Ignore cleanup errors while reporting the primary failure.
  }
  process.exit(1);
});
