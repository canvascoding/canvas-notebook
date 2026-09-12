import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadCachedWorkspaceWidget } from '../app/lib/home/workspace-widget-cache';
import { createWorkspaceWidgetFetcher, internalAppOrigin } from '../app/lib/home/workspace-widget-fetcher';

async function main() {
  const suffix = `${Date.now()}-${Math.random()}`;
  let loads = 0;
  const load = async () => ({ revision: ++loads });
  const base = { userId: `user-a-${suffix}`, workspaceId: 'workspace-a', widget: 'todos', ttlMs: 60_000, load };

  const first = await loadCachedWorkspaceWidget(base);
  const cached = await loadCachedWorkspaceWidget(base);
  assert.equal(first.data.revision, 1);
  assert.equal(cached.data.revision, 1);
  assert.equal(loads, 1, 'a fresh entry should be reused');

  const refreshed = await loadCachedWorkspaceWidget({ ...base, forceRefresh: true });
  assert.equal(refreshed.data.revision, 2);
  assert.equal(loads, 2);

  const staleFallback = await loadCachedWorkspaceWidget<{ revision: number }>({
    ...base,
    forceRefresh: true,
    load: async () => { throw new Error('source unavailable'); },
  });
  assert.equal(staleFallback.data.revision, 2);
  assert.equal(staleFallback.stale, true);

  const otherUser = await loadCachedWorkspaceWidget({ ...base, userId: `user-b-${suffix}` });
  assert.equal(otherUser.data.revision, 3, 'cache entries must be separated by user');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let concurrentLoads = 0;
  const concurrentInput = {
    userId: `user-c-${suffix}`,
    workspaceId: 'workspace-a',
    widget: 'automation',
    ttlMs: 60_000,
    load: async () => { concurrentLoads += 1; await gate; return 'ready'; },
  };
  const pendingA = loadCachedWorkspaceWidget(concurrentInput);
  const pendingB = loadCachedWorkspaceWidget(concurrentInput);
  release();
  assert.deepEqual((await Promise.all([pendingA, pendingB])).map((result) => result.data), ['ready', 'ready']);
  assert.equal(concurrentLoads, 1, 'concurrent loads for the same user and workspace should be deduplicated');

  assert.equal(internalAppOrigin(undefined), 'http://127.0.0.1:3000');
  assert.equal(internalAppOrigin('4711'), 'http://127.0.0.1:4711');
  let internalRequest: { url: string; init?: RequestInit } | undefined;
  const internalFetcher = createWorkspaceWidgetFetcher(
    new Headers({ cookie: 'session=test-session' }),
    async (input, init) => {
      internalRequest = { url: input.toString(), init };
      return new Response(null, { status: 204 });
    },
    'http://127.0.0.1:3000',
  );
  await internalFetcher('/api/todos?workspaceId=workspace-a', {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  assert.equal(internalRequest?.url, 'http://127.0.0.1:3000/api/todos?workspaceId=workspace-a');
  assert.equal(new Headers(internalRequest?.init?.headers).get('cookie'), 'session=test-session');
  assert.equal(new Headers(internalRequest?.init?.headers).get('accept'), 'application/json');
  assert.equal(internalRequest?.init?.cache, 'no-store');

  const routeSource = fs.readFileSync(
    path.join(process.cwd(), 'app', 'api', 'home', 'workspace-widgets', 'route.ts'),
    'utf8',
  );
  assert.doesNotMatch(routeSource, /widget:\s*'emails'/u, 'email must bypass the process-local Home cache');
  assert.match(routeSource, /loadHomeWidgetEmails\(access\.session\.user\.id/u);
  assert.match(routeSource, /services: \{ listAccounts: listEmailAccounts, listMessages: listEmailMessages \}/u);
  assert.match(routeSource, /createWorkspaceWidgetFetcher\(request\.headers\)/u, 'widget API requests must use the container-local fetcher');
  assert.doesNotMatch(routeSource, /new URL\(value, request\.nextUrl\.origin\)/u, 'widget API requests must not use the externally mapped browser port');
  assert.match(routeSource, /parseHomeWidgetSelection\(request\.nextUrl\.searchParams\.get\('widgets'\), HOME_WIDGET_NAMES\)/u);
  assert.match(routeSource, /selected\.has\('emails'\)/u);
  for (const widget of ['todos', 'automation', 'studio']) {
    assert.match(routeSource, new RegExp(`selected\\.has\\('${widget}'\\)[\\s\\S]*widget: '${widget}'`, 'u'), `${widget} should remain independently selectable and cached`);
  }

  console.log('home-workspace-widget-cache-test: ok');
}

void main();
