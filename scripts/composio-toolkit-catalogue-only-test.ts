import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type Call = { path: string; method: string; search: string | null; cursor: string | null; entity: string | null };
type Mode = 'normal' | 'second_error' | 'repeat' | 'timeout' | 'retry_once';

async function createCatalogueFixture() {
  const calls: Call[] = [];
  let mode: Mode = 'normal', failed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const managed = url.pathname === '/v1/managed/composio/toolkits';
    calls.push({ path: url.pathname, method: request.method!, search: url.searchParams.get('search'), cursor: url.searchParams.get('cursor'),
      entity: typeof request.headers['x-canvas-composio-user-id'] === 'string' ? request.headers['x-canvas-composio-user-id'] : url.searchParams.get('user_ids') });
    const send = (body: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET' || !managed && url.pathname !== '/api/v3.1/toolkits') {
      return send({ error: 'Catalogue-only fixture denies account/status/tool/business access.' }, 403);
    }
    if (mode === 'second_error' && url.searchParams.has('cursor') || mode === 'retry_once' && !failed) {
      failed = true;
      return send({ error: 'PRIVATE-UPSTREAM-BODY-DO-NOT-EXPOSE', providerRequestId: 'PRIVATE-ENTITY-DO-NOT-EXPOSE' }, mode === 'second_error' ? 403 : 503);
    }
    const app = url.searchParams.has('cursor') ? { slug: 'duckduckgo', name: 'DuckDuckGo', no_auth: true,
      meta: { description: 'Public search', logo: 'https://logos.example.test/duckduckgo.svg' } }
      : { slug: 'canva', name: 'Canva', no_auth: false, meta: { description: 'Design metadata',
        logo: 'https://logos.example.test/canva.svg?private=removed#fragment' } };
    const result = { [managed ? 'toolkits' : 'items']: [app],
      next_cursor: mode === 'repeat' || !url.searchParams.has('cursor') ? 'catalogue-page-2' : null, total_pages: 2 };
    if (mode === 'timeout') {
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) send(result); }, 1000);
      timers.add(timer);
      return;
    }
    send(result);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    setMode(value: Mode) { mode = value; failed = false; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const provider = await createCatalogueFixture();
  const inheritedFetch = globalThis.fetch;
  const actualFetch = (await import('undici')).fetch;
  const changed = { COMPOSIO_BASE_URL: provider.baseUrl, COMPOSIO_API_KEY: '', COMPOSIO_LOGGING_LEVEL: 'silent',
    CANVAS_CONTROL_PLANE_URL: provider.baseUrl, CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_INSTANCE_TOKEN: 'owned-catalogue-instance-token' };
  const previous = Object.fromEntries(Object.keys(changed).map(key => [key, process.env[key]]));
  Object.assign(process.env, changed);
  let blockedExternal = 0, interceptedSdkUpdate = 0, profileWrites = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === 'https://registry.npmjs.org/@composio/core/latest') {
      interceptedSdkUpdate++;
      return Response.json({ version: '0.0.0' });
    }
    if (url.origin !== provider.baseUrl) {
      blockedExternal++;
      throw new Error('Catalogue fixture blocks external transport before network.');
    }
    assert.equal((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), 'GET');
    assert(['/api/v3.1/toolkits', '/v1/managed/composio/toolkits'].includes(url.pathname));
    return actualFetch(url.href, { ...init, redirect: 'error' } as Parameters<typeof actualFetch>[1]) as unknown as Promise<Response>;
  };
  try {
    const client = await import('../app/lib/composio/composio-client');
    const profiles = await import('../app/lib/composio/composio-profiles');
    const contexts = await import('../app/lib/composio/composio-context');
    const catalogue = await import('../app/lib/integration-tools/adapters/composio');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const { publicPluginExtensionIcon } = await import('../app/lib/plugins/plugin-extension-icons');
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'owned-catalogue-project-key' }], { secretScope: 'system' });
    fixture.setAfterQuery(async query => {
      if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+composio_(?:connection_profiles|workspace_profile_overrides)\b/iu.test(query)) profileWrites++;
    });
    const initialProfiles = await profiles.listExistingComposioProfiles(fixture.owner.userId);
    assert.deepEqual(initialProfiles, []);
    const scope = { secretScope: 'user' as const, userId: fixture.owner.userId };
    const signal = () => new AbortController().signal;
    const local = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal(), { search: 'design request' });
    assert.equal(local.complete, true);
    assert.deepEqual(local.items.map(app => app.slug), ['canva', 'duckduckgo']);
    assert.deepEqual(provider.calls.map(call => [call.method, call.search, call.cursor, call.entity]), [
      ['GET', 'design request', null, null], ['GET', 'design request', 'catalogue-page-2', null],
    ], 'Local catalogue sends neither a fabricated profile nor an account entity.');
    const logo = (local.items[0].meta as { logo: string }).logo;
    assert.equal(publicPluginExtensionIcon(logo, 'composio:canva')?.url, 'https://logos.example.test/canva.svg');
    assert.equal(local.items[1].no_auth, true, 'No-auth is catalogue metadata, not account readiness.');
    assert.equal(profileWrites, 0);
    assert.deepEqual(await profiles.listExistingComposioProfiles(fixture.owner.userId), initialProfiles);

    const first = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal(), { search: 'same query', maxPages: 1 });
    assert.equal(first.complete, false);
    assert.equal(first.nextCursor, 'catalogue-page-2');
    const next = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal(), { search: 'same query', cursor: first.nextCursor });
    assert.equal(next.complete, true);
    assert.deepEqual(next.items.map(app => app.slug), ['duckduckgo']);
    provider.setMode('second_error');
    const partial = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal());
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.items.map(app => app.slug), ['canva']);
    assert.equal(partial.errors[0].code, 'COMPOSIO_CREDENTIALS_OR_SCOPE');
    assert.doesNotMatch(JSON.stringify(partial.errors), /PRIVATE-|catalogue-project-key|owned-catalogue-instance-token/u);
    provider.setMode('repeat');
    const repeated = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal());
    assert.equal(repeated.complete, false);
    assert.equal(repeated.errors[0].code, 'COMPOSIO_BAD_RESPONSE');
    provider.setMode('timeout');
    const localTimeout = await catalogue.loadLocalComposioToolkitCatalogue(scope, AbortSignal.timeout(50));
    assert.equal(localTimeout.complete, false);
    assert.equal(localTimeout.errors[0].code, 'COMPOSIO_TIMEOUT');
    assert.equal(profileWrites, 0);
    assert.deepEqual(await profiles.listExistingComposioProfiles(fixture.owner.userId), []);

    // Deliberately arrange one real profile, then verify that all managed calls
    // retain it without creating a default/profile/override as a side effect.
    const arranged = await profiles.createComposioProfile({ ownerUserId: fixture.owner.userId, name: 'Existing catalogue context' });
    const existing = await contexts.resolveBoundComposioContext({ ...fixture.owner, profileId: arranged.id });
    const managedBefore = await profiles.listExistingComposioProfiles(fixture.owner.userId);
    profileWrites = 0;
    const startManaged = provider.calls.length;
    provider.setMode('normal');
    const managed = await catalogue.loadManagedComposioToolkitCatalogue(existing, signal(), { search: 'current managed query' });
    assert.equal(managed.complete, true);
    assert.deepEqual(managed.items.map(app => app.slug), ['canva', 'duckduckgo']);
    assert.deepEqual(provider.calls.slice(startManaged).map(call => [call.method, call.search, call.cursor, call.entity]), [
      ['GET', 'current managed query', null, existing.composioUserId],
      ['GET', 'current managed query', 'catalogue-page-2', existing.composioUserId],
    ]);
    const requestCount = provider.calls.length;
    await assert.rejects(() => catalogue.loadManagedComposioToolkitCatalogue(undefined!, signal()), /resolved user and workspace/u);
    assert.equal(provider.calls.length, requestCount, 'Managed zero-context never fabricates a provider entity.');
    provider.setMode('retry_once');
    const beforeRetry = provider.calls.length;
    const retried = await catalogue.loadManagedComposioToolkitCatalogue(existing, signal());
    assert.equal(retried.complete, true);
    assert.equal(provider.calls.length - beforeRetry, 3, 'Existing managed read retry is retained, followed by the actual second page.');
    provider.setMode('second_error');
    const managedPartial = await catalogue.loadManagedComposioToolkitCatalogue(existing, signal());
    assert.equal(managedPartial.complete, false);
    assert.equal(managedPartial.items[0].slug, 'canva');
    assert.equal(managedPartial.errors[0].code, 'COMPOSIO_CREDENTIALS_OR_SCOPE');
    assert.doesNotMatch(JSON.stringify(managedPartial.errors), /PRIVATE-|owned-catalogue|composioUserId/u);
    provider.setMode('timeout');
    const managedTimeout = await catalogue.loadManagedComposioToolkitCatalogue(existing, AbortSignal.timeout(50));
    assert.equal(managedTimeout.complete, false);
    assert.equal(managedTimeout.errors[0].code, 'COMPOSIO_TIMEOUT');
    assert.equal(profileWrites, 0);
    assert.deepEqual(await profiles.listExistingComposioProfiles(fixture.owner.userId), managedBefore);

    await replaceScopedEnvEntries('integrations', [], { secretScope: 'system' });
    client.resetComposioInstance();
    const beforeDisabled = provider.calls.length;
    const disabled = await catalogue.loadLocalComposioToolkitCatalogue(scope, signal());
    assert.equal(disabled.complete, false);
    assert.equal(disabled.errors[0].code, 'COMPOSIO_NOT_CONFIGURED');
    assert.equal(provider.calls.length, beforeDisabled);
    assert.equal(profileWrites, 0);
    assert.equal(blockedExternal, 0);
    assert(provider.calls.every(call => call.method === 'GET' && ['/api/v3.1/toolkits', '/v1/managed/composio/toolkits'].includes(call.path)));
    console.log(`PASS catalogue-only Composio: real SQL/profile/context + SDK/managed HTTP, search/cursor/pages/logo, partial/repeat/timeout/retry; account/status/tools/business requests 0, implicit profile writes 0, external requests 0; intercepted SDK update metadata ${interceptedSdkUpdate}.`);
  } finally {
    globalThis.fetch = inheritedFetch;
    await provider.close();
    await fixture.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
