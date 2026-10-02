import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { NextRequest } from 'next/server';
import { StudioServiceError } from '../app/lib/integrations/studio-errors';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const exports = {};
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-studio-bulk-policy-'));
  const previousDataRoot = process.env.CANVAS_DATA_ROOT;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  try {
    const availability = await import('../app/lib/studio-bulk-availability');
    const { serverPreferencesPath } = await import('../app/lib/terminal-policy');
    const setEnabled = async (enabled: boolean) => {
      await mkdir(path.dirname(serverPreferencesPath()), { recursive: true });
      await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: {
        studioBulkEnabled: enabled, studioBulkUpdatedAt: new Date().toISOString(),
      } }));
    };
    const job = { id: 'existing-job', userId: 'admin', workspaceId: 'workspace', name: null,
      studioPresetId: null, additionalPrompt: 'existing', aspectRatio: '1:1', versionsPerProduct: 1,
      status: 'processing', totalLineItems: 1, completedLineItems: 0, failedLineItems: 0,
      createdAt: new Date(), updatedAt: new Date() };
    const item = { id: 'existing-item', bulkJobId: job.id, productId: null, personaId: null,
      studioPresetId: null, customPrompt: null, generationId: null, status: 'pending', createdAt: new Date() };
    const jobs = { id: 'jobs.id', workspaceId: 'jobs.workspaceId', createdAt: 'jobs.createdAt' };
    const items = { id: 'items.id', bulkJobId: 'items.bulkJobId', status: 'items.status', createdAt: 'items.createdAt' };
    let databaseCalls = 0;
    let providerCalls = 0;
    let failDatabase = true;
    const db = {
      select() {
        databaseCalls++;
        if (failDatabase) throw new Error('DATABASE_REACHED');
        return { from(table: unknown) {
          const rows = table === jobs ? [job] : table === items ? [item] : [];
          const query = { where() { return query; }, orderBy() { return query; },
            then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            } };
          return query;
        } };
      },
      update(table: unknown) {
        databaseCalls++;
        if (failDatabase) throw new Error('DATABASE_REACHED');
        return { set(values: object) { return { async where() { Object.assign(table === jobs ? job : item, values); } }; } };
      },
      insert() { databaseCalls++; throw new Error('Unexpected job insert'); },
    };
    const service = await compile<typeof import('../app/lib/integrations/studio-bulk-service')>(
      'app/lib/integrations/studio-bulk-service.ts', {
        'server-only': {}, '@/app/lib/db': { db },
        '@/app/lib/db/schema': { studioBulkJobs: jobs, studioBulkJobLineItems: items },
        'drizzle-orm': Object.fromEntries(['eq', 'and', 'desc', 'inArray', 'count', 'or'].map(name => [name, () => ({})])),
        '@/app/lib/integrations/studio-generation-service': { executeStudioGeneration() { providerCalls++; throw new Error('Unexpected provider call'); } },
        '@/app/lib/integrations/studio-errors': { StudioServiceError },
        '@/app/lib/utils/media-url': { toMediaUrl: () => null },
        '@/app/lib/studio-bulk-availability': availability,
      });
    const scope = { actorUserId: 'admin', organizationId: 'organization', workspaceId: 'workspace',
      storage: { organizationId: 'organization', workspaceId: 'workspace' } } as Parameters<typeof service.createBulkJob>[0];
    const input = { productIds: ['00000000-0000-4000-8000-000000000001'], prompt: 'gate regression' };
    const disabled = (error: unknown) => error instanceof StudioServiceError && error.code === 'STUDIO_BULK_DISABLED';
    await assert.rejects(service.createBulkJob(scope, input), disabled, 'missing policy blocks direct service and agent callers');
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
    await setEnabled(true);
    await assert.rejects(service.createBulkJob(scope, { productIds: [], prompt: '' }),
      error => error instanceof StudioServiceError && error.code === 'VALIDATION', 'enabled feature retains input validation');
    await assert.rejects(service.createBulkJob(scope, input), /DATABASE_REACHED/u, 'enabled jobs reach the existing service pipeline');
    databaseCalls = 0;
    await setEnabled(false);
    await assert.rejects(service.createBulkJob(scope, input), disabled);

    const routeMocks = {
      '@/app/lib/auth': { auth: { api: { getSession: async () => ({ user: { id: 'admin' } }) } } },
      '@/app/lib/integrations/studio-bulk-service': service,
      '@/app/lib/integrations/studio-errors': { StudioServiceError },
      '@/app/lib/integrations/studio-request-scope': { requireStudioRequestScope: async () => ({ scope }) },
    };
    const web = await compile<typeof import('../app/api/studio/bulk/route')>('app/api/studio/bulk/route.ts', routeMocks);
    class MobileStudioError extends Error { constructor(message: string, public status: number, public code: string) { super(message); } }
    const mobileErrors = await compile<typeof import('../app/lib/mobile/studio-route')>('app/lib/mobile/studio-route.ts', {
      'server-only': {}, '@/app/lib/api/route-helpers': { jsonServerError: () => { throw new Error('Unexpected unknown error'); } },
      '@/app/lib/integrations/integration-service-error': { IntegrationServiceError: class extends Error {} },
      '@/app/lib/integrations/studio-errors': { StudioServiceError }, './studio': { MobileStudioError },
    });
    const mobile = await compile<typeof import('../app/api/mobile/v1/studio/bulk/route')>('app/api/mobile/v1/studio/bulk/route.ts', {
      ...routeMocks, '@/app/lib/mobile/studio': { MobileStudioError }, '@/app/lib/mobile/studio-route': mobileErrors,
    });
    const webResponse = await web.POST(new NextRequest('http://localhost/api/studio/bulk', {
      method: 'POST', body: JSON.stringify({ product_ids: input.productIds, prompt: input.prompt }),
    }));
    const mobileResponse = await mobile.POST(new NextRequest('http://localhost/api/mobile/v1/studio/bulk', {
      method: 'POST', body: JSON.stringify(input),
    }));
    assert.equal(webResponse.status, 403);
    assert.equal(mobileResponse.status, 403);
    assert.deepEqual(await webResponse.json(), await mobileResponse.json(), 'web/mobile use the same disabled error contract');
    for (const [code, status] of [['NOT_FOUND', 404], ['FORBIDDEN', 403], ['RATE_LIMIT', 429], ['VALIDATION', 400]] as const) {
      assert.equal(mobileErrors.mobileStudioErrorResponse(new StudioServiceError('existing', 'existing', code), 'test').status,
        status, `existing mobile ${code} mapping remains unchanged`);
    }
    const tools = await compile<typeof import('../app/lib/pi/studio-tools')>('app/lib/pi/studio-tools.ts', {
      '@/app/lib/integrations/studio-generation-service': {}, '@/app/lib/integrations/studio-product-service': {},
      '@/app/lib/integrations/studio-persona-service': {}, '@/app/lib/integrations/studio-style-service': {},
      '@/app/lib/integrations/studio-workspace': {}, '@/app/lib/utils/media-url': {},
      '@/app/lib/integrations/studio-bulk-service': service, '@/app/lib/integrations/studio-preset-service': {},
      '@/app/lib/integrations/studio-scope': { createPersistedStudioScope: () => scope },
      '@/app/lib/integrations/studio-workspace-file-migration': { ensureStudioWorkspaceFilesMigrated: async () => {} },
      '@/app/lib/integrations/audio-transcription-service': {}, '@/app/lib/pi/tool-runtime-helpers': {},
      '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => ({
        userId: 'admin', organizationId: 'organization', workspaceId: 'workspace',
      }) },
    });
    await assert.rejects(tools.createStudioBulkGenerateTool({ userId: 'admin' }).execute('bulk-test', {
      product_ids: input.productIds, prompt: input.prompt,
    }), disabled, 'actual agent tool delegates to the same disabled gate');
    assert.equal(databaseCalls, 0, 'disabled direct/web/mobile/agent creation never touches the database');
    assert.equal(providerCalls, 0, 'disabled creation cannot invoke a generation provider');
    failDatabase = false;
    assert.equal((await service.listBulkJobs(scope))[0].id, job.id, 'existing history remains readable while off');
    assert.equal((await service.getBulkJob(job.id, scope))?.id, job.id, 'existing job results remain readable while off');
    await service.cancelBulkJob(job.id, scope);
    assert.equal(job.status, 'failed', 'existing active job can still be canceled while off');
    assert.equal(item.status, 'failed');
    assert.equal(providerCalls, 0);

    // Exercise the real proxy, authentication cookie parser and next-intl routing.
    // A disabled page must redirect before StudioShell can render a Bulk title.
    const { default: middleware } = await import('../proxy');
    const { usesSecureAuthCookies } = await import('../app/lib/auth-cookie');
    const origin = 'https://bulk-policy.example.test';
    const cookieName = usesSecureAuthCookies() ? '__Host-better-auth.session_token' : 'better-auth.session_token';
    const headers = { cookie: `${cookieName}=fixture-policy-session` };
    for (const preference of [{}, { studioBulkEnabled: false }]) {
      await writeFile(serverPreferencesPath(), JSON.stringify({ version: 1, settings: preference }));
      for (const locale of ['de', 'en']) {
        for (const method of ['GET', 'HEAD']) {
          for (const suffix of ['', '/']) {
            const response = await middleware(new NextRequest(`${origin}/${locale}/studio/bulk${suffix}`, { method, headers }));
            assert.equal(response.status, 307, `${locale} ${method} disabled/missing bulk policy redirects before rendering`);
            assert.equal(response.headers.get('location'), `${origin}/${locale}/studio`, 'redirect preserves the requested locale');
            assert.equal(response.headers.get('cache-control'), 'no-store', 'redirect cannot cache a disabled policy');
            assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
            assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'self'/u);
          }
        }
      }
    }
    for (const locale of ['de', 'en']) {
      const response = await middleware(new NextRequest(`${origin}/${locale}/studio/bulk?workspaceId=fixture`));
      assert.equal(response.status, 307);
      const login = new URL(response.headers.get('location')!);
      assert.equal(login.pathname, locale === 'de' ? '/login' : '/en/login', 'anonymous pages retain the existing login routing');
      assert.equal(login.searchParams.get('from'), `/${locale}/studio/bulk?workspaceId=fixture`, 'login retains the original destination');
    }
    await setEnabled(true);
    for (const locale of ['de', 'en']) {
      const response = await middleware(new NextRequest(`${origin}/${locale}/studio/bulk`, { headers }));
      assert.equal(response.status, 200, 'enabled bulk reaches normal locale rendering');
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('x-middleware-next'), '1', 'enabled page retains the actual next-intl pass-through response');
      assert.equal(response.headers.get('x-middleware-request-x-next-intl-locale'), locale,
        'enabled page retains the locale header set by next-intl');
    }
    await setEnabled(false);
    for (const pathname of ['/de/studio/model', '/en/studio/model', '/de/studio/bulk/history', '/en/studio/bulk-extra']) {
      const response = await middleware(new NextRequest(`${origin}${pathname}`, { headers }));
      assert.equal(response.status, 200, 'bulk policy does not change other Studio routes or prefix lookalikes');
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('x-middleware-next'), '1');
      assert.equal(response.headers.get('x-middleware-request-x-next-intl-locale'), pathname.split('/')[1]);
    }
    for (const pathname of ['/api/studio/bulk', '/api/studio/bulk/availability', '/api/mobile/v1/studio/bulk']) {
      for (const method of ['GET', 'POST']) {
        const response = await middleware(new NextRequest(`${origin}${pathname}`, { headers, method }));
        assert.equal(response.status, 200, 'API routes retain their own authentication and service policy');
        assert.equal(response.headers.get('location'), null);
        assert.equal(response.headers.get('x-middleware-next'), '1');
      }
    }
    const mutation = await middleware(new NextRequest(`${origin}/de/studio/bulk`, { headers, method: 'POST' }));
    assert.equal(mutation.status, 200, 'page redirect applies only to GET and HEAD');
    assert.equal(mutation.headers.get('location'), null);
    console.log('studio-bulk-policy-test: central gate, web/mobile/agent errors, no creation side effects, existing-job access and real proxy redirects passed');
  } finally {
    if (previousDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
