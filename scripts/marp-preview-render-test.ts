import assert from 'node:assert/strict';
import Module from 'node:module';

type MarpRenderModule = typeof import('../app/lib/marp/render');

async function importMarpRenderer(): Promise<MarpRenderModule> {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/marp/render');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  const { renderMarpMarkdownToHtmlDocument } = await importMarpRenderer();
  const html = await renderMarpMarkdownToHtmlDocument(`---
marp: true
theme: default
---

# First slide

---

# Second slide
`, { filePath: 'test-presentation.marp.md' });

  assert.match(html, /div\.marpit > svg > foreignObject > section/);
  assert.match(html, /<div class="marpit"><svg role="img" aria-label="Slide 1"/);
  assert.match(html, /<p class="marp-slide-caption" aria-hidden="true">Slide 1<\/p>/);
  assert.match(html, /<svg role="img" aria-label="Slide 2"/);
  assert.doesNotMatch(html, /marp-slide-frame|marp-slide-surface/);

  console.log('marp-preview-render-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
