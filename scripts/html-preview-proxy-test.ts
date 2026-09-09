import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

async function main(): Promise<void> {
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';

  const { default: middleware } = await import('../proxy');
  const ticket = 'a'.repeat(43);

  for (const [method, mode] of [['GET', 'frame'], ['HEAD', 'document']] as const) {
    const response = await middleware(new NextRequest(
      `https://app.example.test/__preview/${ticket}/mcp-app/${mode}`,
      { method, headers: { host: 'app.example.test' } },
    ));
    assert.equal(response.headers.get('x-middleware-next'), '1', `${method} ${mode} must reach the ticket route`);
  }

  for (const [method, pathname] of [
    ['POST', `/__preview/${ticket}/mcp-app/frame`],
    ['GET', `/__preview/${ticket}/mcp-app/other`],
    ['GET', `/__preview/${ticket}/index.html`],
  ] as const) {
    const response = await middleware(new NextRequest(`https://app.example.test${pathname}`, {
      method,
      headers: { host: 'app.example.test' },
    }));
    assert.equal(response.status, 404, `${method} ${pathname} must remain blocked on the app origin`);
  }

  const isolatedPreview = await middleware(new NextRequest(
    `https://preview.app.example.test/__preview/${ticket}/index.html`,
    { headers: { host: 'preview.app.example.test' } },
  ));
  assert.equal(isolatedPreview.headers.get('x-middleware-next'), '1');

  console.log('HTML preview proxy boundary tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
