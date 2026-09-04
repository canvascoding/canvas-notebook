import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  const { renderMarpMarkdownToHtmlDocument, renderMarpMarkdownToMobilePreview } = await importMarpRenderer();
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

  const fixtureDirectory = path.join(process.cwd(), 'scripts/fixtures/marp-mobile');
  const mobilePreview = await renderMarpMarkdownToMobilePreview(
    await readFile(path.join(fixtureDirectory, 'basic.marp.md'), 'utf8'),
    { filePath: 'fixtures/basic.marp.md' },
  );
  assert.equal(mobilePreview.contractVersion, 'marp-preview.v1');
  assert.equal(mobilePreview.profile, 'marp-mobile-v1');
  assert.equal(mobilePreview.deck.slideCount, 2);
  assert.equal(mobilePreview.deck.slides[0]?.width, 1280);
  assert.equal(mobilePreview.deck.slides[0]?.height, 720);
  assert.match(mobilePreview.html, /\.marpit>svg\[data-canvas-active="true"\]/u);
  const scriptNonce = mobilePreview.html.match(/script-src 'nonce-([^']+)'/u)?.[1];
  assert.ok(scriptNonce);
  const scripts = Array.from(mobilePreview.html.matchAll(/<script\b([^>]*)>/gu));
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every((script) => script[1]?.includes(`nonce="${scriptNonce}"`)));
  assert.doesNotMatch(mobilePreview.html, /script-src 'unsafe-inline'/u);
  assert.doesNotMatch(mobilePreview.html, /<script\b[^>]*\bsrc=/u);
  assert.doesNotMatch(mobilePreview.html, /img-src[^>]*https:/u);

  const remotePreview = await renderMarpMarkdownToMobilePreview(
    await readFile(path.join(fixtureDirectory, 'remote-asset.marp.md'), 'utf8'),
    { filePath: 'fixtures/remote-asset.marp.md' },
  );
  assert.deepEqual(remotePreview.warnings, [{
    code: 'REMOTE_ASSET_BLOCKED',
    reference: 'https://example.invalid/remote.png',
  }]);
  assert.doesNotMatch(remotePreview.html, /example\.invalid/u);

  console.log('marp-preview-render-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
