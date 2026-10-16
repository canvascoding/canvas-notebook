import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mcpIconSourceBinding } from '../app/lib/mcp/icon-source';

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z" fill="#246"/></svg>');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-bound-icon-'));
  const previous = { DATA: process.env.DATA, CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT };
  Object.assign(process.env, { DATA: root, CANVAS_DATA_ROOT: root });
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const receipts: Array<{ url: string; headers: Headers }> = [];
  let kind: 'valid' | 'missing' | 'active' | 'spoofed' = 'valid';
  let duringImage: (() => void) | undefined;
  loader._load = (name, parent, isMain) => name === '@/app/lib/mcp/http' || name.endsWith('/app/lib/mcp/http.ts')
    ? { fetchMcpHttp: async (url: string, init: RequestInit) => {
      receipts.push({ url, headers: new Headers(init.headers) });
      if (url === 'https://mcp.icons.example' || url === 'https://icons.example') {
        return url === 'https://icons.example' && kind !== 'missing'
          ? new Response('<html><link rel="apple-touch-icon" href="/logo.svg"></html>', { headers: { 'Content-Type': 'text/html' } })
          : new Response(null, { status: 404 });
      }
      if (url === 'https://icons.example/logo.svg' && kind !== 'missing') {
        duringImage?.();
        return new Response(kind === 'active' ? '<svg><script>alert(1)</script></svg>' : kind === 'spoofed' ? '<html>Not an image</html>' : svg,
          { headers: { 'Content-Type': 'image/svg+xml' } });
      }
      return new Response(null, { status: 404 });
    } } : originalLoad(name, parent, isMain);
  globalThis.fetch = async () => { throw new Error('Unexpected non-guarded image transport.'); };
  try {
    const { readSourceBoundMcpServerIcon } = await import('../app/lib/mcp/icons');
    const { resolveMcpStoragePath } = await import('../app/lib/mcp/storage');
    const config = { connectionId: '11111111-1111-4111-8111-111111111111', ownerUserId: 'alice', authVersion: 3,
      url: 'https://mcp.icons.example/mcp?token=PRIVATE_MCP_QUERY', headers: { Authorization: 'PRIVATE_MCP_HEADER' } };
    const binding = mcpIconSourceBinding(`mcp-personal:${config.connectionId}`, config), scope = { userId: 'alice' };
    let current = true;
    const guard = async () => { assert(current, 'The current source was revoked.'); };
    const read = () => readSourceBoundMcpServerIcon(config, binding, scope, guard);
    const first = await Promise.all(Array.from({ length: 8 }, read));
    for (const image of first) { assert.equal(image?.contentType, 'image/svg+xml'); assert.deepEqual(image?.buffer, svg); }
    assert.equal(receipts.filter(value => value.url.endsWith('/logo.svg')).length, 1, 'Concurrent cold requests coalesce one discovery');
    assert(receipts.some(value => value.url === 'https://icons.example/logo.svg'), 'The existing parent-domain fallback remains usable for a subdomain MCP');
    const beforeCached = receipts.length;
    assert.deepEqual((await read())?.buffer, svg); assert.equal(receipts.length, beforeCached, 'Positive cache serves local bytes without remote URL requests');
    for (const receipt of receipts) {
      assert(!receipt.url.includes('PRIVATE')); assert(!receipt.headers.has('Authorization')); assert(!receipt.headers.has('Cookie'));
    }
    const cacheFile = resolveMcpStoragePath(`mcp-icons/bound-${binding}.json`, scope);
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    cache.fetchedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.writeFile(cacheFile, JSON.stringify(cache));
    await read(); assert(receipts.length > beforeCached, 'Seven-day positive TTL refreshes exactly the bound image');
    const emptyBinding = mcpIconSourceBinding('empty', config); kind = 'missing';
    assert.equal(await readSourceBoundMcpServerIcon(config, emptyBinding, scope, guard), null);
    const afterMissing = receipts.length;
    assert.equal(await readSourceBoundMcpServerIcon(config, emptyBinding, scope, guard), null);
    assert.equal(receipts.length, afterMissing, 'Negative TTL prevents a repeated full discovery on every render');
    const negativeFile = resolveMcpStoragePath(`mcp-icons/bound-${emptyBinding}.json`, scope);
    const negative = JSON.parse(await fs.readFile(negativeFile, 'utf8')); negative.fetchedAt = Date.now() - 61 * 60 * 1000;
    await fs.writeFile(negativeFile, JSON.stringify(negative)); kind = 'valid';
    assert.deepEqual((await readSourceBoundMcpServerIcon(config, emptyBinding, scope, guard))?.buffer, svg, 'Expired negative entry can become a real image');
    const foreignCache = JSON.parse(await fs.readFile(negativeFile, 'utf8'));
    const currentCache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    currentCache.metadata.fileName = foreignCache.metadata.fileName;
    await fs.writeFile(cacheFile, JSON.stringify(currentCache)); kind = 'missing';
    const beforeCrossSource = receipts.length;
    assert.equal(await read(), null, 'A cache record cannot serve a different bound connection image from the same storage scope');
    assert(receipts.length > beforeCrossSource, 'Cross-source cache filenames are rejected and rediscovered rather than served');
    currentCache.metadata.fileName = cache.metadata.fileName; currentCache.metadata.origin = 'https://previous.example';
    await fs.writeFile(cacheFile, JSON.stringify(currentCache));
    assert.equal(await read(), null, 'Previous source origins cannot manufacture a current cached image');
    for (const invalid of ['active', 'spoofed'] as const) {
      kind = invalid;
      assert.equal(await readSourceBoundMcpServerIcon(config, mcpIconSourceBinding(invalid, config), scope, guard), null,
        'A MIME declaration cannot turn active SVG or HTML into served image bytes');
    }
    kind = 'valid'; duringImage = () => { current = false; };
    await assert.rejects(() => readSourceBoundMcpServerIcon(config, mcpIconSourceBinding('late-revoke', config), scope, guard));
    assert.equal(await fs.access(resolveMcpStoragePath(`mcp-icons/bound-${mcpIconSourceBinding('late-revoke', config)}.json`, scope)).then(() => true, () => false), false,
      'Late revocation does not publish cache metadata or image bytes');
    current = true; duringImage = undefined;
    let firstViewerCurrent = true;
    const firstViewerGuard = async () => { if (!firstViewerCurrent) throw new DOMException('The first viewer left.', 'AbortError'); };
    const secondViewerGuard = async () => {};
    const joinedBinding = mcpIconSourceBinding('joined-viewers', config);
    let firstImage = true;
    duringImage = () => { if (firstImage) { firstImage = false; firstViewerCurrent = false; } };
    const beforeJoined = receipts.length;
    const results = await Promise.allSettled([
      readSourceBoundMcpServerIcon(config, joinedBinding, scope, firstViewerGuard),
      readSourceBoundMcpServerIcon(config, joinedBinding, scope, secondViewerGuard),
    ]);
    assert.equal(results[0].status, 'rejected', 'An obsolete first viewer receives no image bytes');
    assert.equal(results[1].status, 'fulfilled');
    if (results[1].status === 'fulfilled') assert.deepEqual(results[1].value?.buffer, svg, 'A still-authorized joiner rechecks its own authority and takes over once');
    assert.equal(receipts.slice(beforeJoined).filter(value => value.url.endsWith('/logo.svg')).length, 2, 'Only the authority-owner failure receives one bounded fresh takeover');
    duringImage = undefined;
    assert.notEqual(mcpIconSourceBinding('one', config), mcpIconSourceBinding('two', config));
    assert.notEqual(binding, mcpIconSourceBinding(`mcp-personal:${config.connectionId}`, { ...config, url: 'https://other.example/mcp' }));
    assert.notEqual(binding, mcpIconSourceBinding(`mcp-personal:${config.connectionId}`, { ...config, authVersion: 4 }));
    console.log('PASS bound MCP image cache: cold coalescing, actual saved bytes, parent-domain discovery, positive/negative TTL, source identity, no MCP headers/query credentials and passive-image/late-revocation fences. Guarded HTTP responses are controlled unit fixtures.');
  } finally {
    loader._load = originalLoad; globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
