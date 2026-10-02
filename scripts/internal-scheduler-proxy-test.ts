import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let pollCalls = 0;

async function main(): Promise<void> {
  const previousToken = process.env.CANVAS_INTERNAL_API_KEY;
  const previousBaseUrl = process.env.BETTER_AUTH_BASE_URL;
  const token = 'internal-scheduler-regression-token';
  process.env.CANVAS_INTERNAL_API_KEY = token;
  process.env.BETTER_AUTH_BASE_URL = 'https://app.example.test';
  moduleInternals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/todos/email-reply-watchers') {
      return { pollTodoEmailReplies: async () => {
        pollCalls += 1;
        return { processed: 0, failed: 0, expired: 0 };
      } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const { default: middleware } = await import('../proxy');
    const { POST } = await import('../app/api/todos/email-replies/poll/route');
    const pathname = '/api/todos/email-replies/poll';
    for (const [providedToken, expectedStatus] of [[token, 200], ['', 401], ['wrong-token', 401]] as const) {
      const request = new NextRequest(`https://app.example.test${pathname}`, {
        method: 'POST',
        headers: { host: 'app.example.test', ...(providedToken ? { 'x-canvas-internal-token': providedToken } : {}) },
      });
      assert.equal(request.cookies.getAll().length, 0);
      const proxyResponse = await middleware(request);
      assert.equal(proxyResponse.headers.get('x-middleware-next'), '1',
        'The exact scheduler endpoint must reach its own token authorization without a browser cookie.');
      const before = pollCalls;
      const response = await POST(request);
      assert.equal(response.status, expectedStatus);
      assert.equal(pollCalls - before, expectedStatus === 200 ? 1 : 0,
        'Unauthorized requests must never invoke the email poller.');
    }
    process.env.CANVAS_INTERNAL_API_KEY = '';
    const unconfigured = await POST(new NextRequest(`https://app.example.test${pathname}`, {
      method: 'POST', headers: { 'x-canvas-internal-token': token },
    }));
    assert.equal(unconfigured.status, 401, 'An unconfigured internal token must fail closed.');
    assert.equal(pollCalls, 1);

    for (const protectedPath of [`${pathname}/child`, `${pathname}ing`, '/api/todos/email-replies', '/api/todos']) {
      const response = await middleware(new NextRequest(`https://app.example.test${protectedPath}`, {
        method: 'POST', headers: { host: 'app.example.test', 'x-canvas-internal-token': token },
      }));
      assert.equal(response.status, 401, `${protectedPath} must still require a browser session.`);
      assert.notEqual(response.headers.get('x-middleware-next'), '1');
    }
    console.log('Internal scheduler proxy and token boundary tests passed (8 cases).');
  } finally {
    moduleInternals._load = originalLoad;
    if (previousToken === undefined) delete process.env.CANVAS_INTERNAL_API_KEY;
    else process.env.CANVAS_INTERNAL_API_KEY = previousToken;
    if (previousBaseUrl === undefined) delete process.env.BETTER_AUTH_BASE_URL;
    else process.env.BETTER_AUTH_BASE_URL = previousBaseUrl;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
