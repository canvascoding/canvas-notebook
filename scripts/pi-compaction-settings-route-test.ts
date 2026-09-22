import assert from 'node:assert/strict';
import Module from 'node:module';
import { NextRequest, NextResponse } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
let allowAdmin = true;
let organization = { configured: true, organizationId: 'org-a' as string | null, permission: 'owner' };
let serviceFailure: 'catalog' | 'settings' | 'unavailable' | null = null;
const updates: unknown[] = [];
const audits: unknown[] = [];

class MockPiCompactionSettingsError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 409) {
    super(message);
  }
}

function matches(request: string, suffix: string): boolean {
  return request === `@/app/lib/${suffix}` || request.endsWith(`/app/lib/${suffix}`);
}

const data = {
  catalogRevision: 7,
  settingsRevision: 3,
  persisted: { configured: true, tailMode: 'lean' as const, summaryModel: null, summaryModelUnavailable: false },
  editable: { tailMode: 'lean' as const, summaryModel: null },
  configuration: {
    tailMode: 'lean' as const,
    summaryModel: null,
    summaryRoute: 'main' as const,
    sources: { tailMode: 'persisted' as const, summaryModel: 'default' as const },
  },
  summaryModels: [],
  preview: null,
};

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (matches(request, 'admin-auth')) {
    return {
      requireInstanceAdmin: async () => allowAdmin
        ? { ok: true, session: { user: { id: 'admin-1' } } }
        : { ok: false, response: NextResponse.json({ success: false }, { status: 401 }) },
    };
  }
  if (matches(request, 'organization/permissions')) {
    return {
      readOrganizationPermissionForUser: async () => organization,
      isOrganizationAdminLike: (permission: string) => permission === 'owner',
    };
  }
  if (matches(request, 'utils/rate-limit')) return { rateLimit: () => ({ ok: true }) };
  if (matches(request, 'audit/audit-service')) return { recordAuditEvent: async (event: unknown) => { audits.push(event); } };
  if (matches(request, 'pi/compaction/settings-service')) {
    return {
      PiCompactionSettingsError: MockPiCompactionSettingsError,
      readPiCompactionAdminSettings: async () => data,
      updatePiCompactionAdminSettings: async (input: unknown) => {
        if (serviceFailure === 'catalog') throw new MockPiCompactionSettingsError('CATALOG_REVISION_CONFLICT', 'catalog changed', 409);
        if (serviceFailure === 'settings') throw new MockPiCompactionSettingsError('SETTINGS_REVISION_CONFLICT', 'settings changed', 409);
        if (serviceFailure === 'unavailable') throw new MockPiCompactionSettingsError('SUMMARY_MODEL_UNAVAILABLE', 'model unavailable', 400);
        updates.push(input);
        return data;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const route = await import('../app/api/admin/agent-runtime/compaction/route');
    const get = await route.GET(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction'));
    assert.equal(get.status, 200);
    assert.equal((await get.json()).data.settingsRevision, 3);

    const invalid = await route.PATCH(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tailMode: 'lean', summaryModel: null, expectedCatalogRevision: 7 }),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(updates.length, 0);

    const patch = await route.PATCH(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tailMode: 'lean', summaryModel: null, expectedCatalogRevision: 7, expectedSettingsRevision: 3 }),
    }));
    assert.equal(patch.status, 200);
    assert.deepEqual(updates[0], {
      organizationId: 'org-a', actorUserId: 'admin-1', tailMode: 'lean', summaryModel: null,
      expectedCatalogRevision: 7, expectedSettingsRevision: 3,
    });
    assert.equal(audits.length, 1);

    organization = { configured: true, organizationId: 'org-a', permission: 'member' };
    const forbidden = await route.GET(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction'));
    assert.equal(forbidden.status, 403);

    organization = { configured: false, organizationId: null, permission: 'owner' };
    const unconfigured = await route.GET(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction'));
    assert.equal(unconfigured.status, 409);
    organization = { configured: true, organizationId: 'org-a', permission: 'owner' };

    for (const [failure, status, code] of [
      ['catalog', 409, 'CATALOG_REVISION_CONFLICT'],
      ['settings', 409, 'SETTINGS_REVISION_CONFLICT'],
      ['unavailable', 400, 'SUMMARY_MODEL_UNAVAILABLE'],
    ] as const) {
      serviceFailure = failure;
      const failedPatch = await route.PATCH(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tailMode: 'lean', summaryModel: null, expectedCatalogRevision: 7, expectedSettingsRevision: 3 }),
      }));
      assert.equal(failedPatch.status, status);
      assert.equal((await failedPatch.json()).code, code);
    }
    serviceFailure = null;

    allowAdmin = false;
    const denied = await route.GET(new NextRequest('https://canvas.test/api/admin/agent-runtime/compaction'));
    assert.equal(denied.status, 401);
    console.log('pi-compaction-settings-route-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
