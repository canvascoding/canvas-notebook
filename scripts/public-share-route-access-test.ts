import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

import middleware from '../proxy';

const publicShareRequests: ReadonlyArray<{ path: string; method?: string }> = [
  { path: '/p/example-code' },
  { path: '/public/files/example-token/report.md' },
  { path: '/public/view/example-token/report.md' },
  { path: '/public/markdown-assets/example-token/images/chart.png' },
  { path: '/public/markdown-export/example-token' },
  { path: '/public/markdown-pdf/example-token', method: 'POST' },
  { path: '/public/marp-preview/example-token' },
];

async function main() {
  for (const { path, method } of publicShareRequests) {
    const response = await middleware(new NextRequest(`http://localhost${path}`, { method }));

    assert.equal(
      response.headers.get('x-middleware-next'),
      '1',
      `${method || 'GET'} ${path} must bypass authentication as a public share route`,
    );
  }

  console.log('public-share-route-access-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
