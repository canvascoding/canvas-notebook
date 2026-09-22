import assert from 'node:assert/strict';
import Module from 'node:module';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

type Row = {
  tail_mode: string | null;
  summary_model: string | null;
  revision: number;
  updated_at: number;
};

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
const rows = new Map<string, Row>();
const calls: string[] = [];

function matches(request: string, suffix: string): boolean {
  return request === `@/app/lib/${suffix}` || request.endsWith(`/app/lib/${suffix}`);
}

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (matches(request, 'db')) {
    return {
      openDb: async () => ({
        get: async (sql: string, params?: unknown[]) => {
          calls.push(sql);
          const organizationId = String(params?.[0] ?? '');
          if (sql.includes('canvas_organization_settings')) return { organization_id: organizationId };
          return rows.get(organizationId);
        },
        run: async (sql: string, params?: unknown[]) => {
          calls.push(sql);
          if (sql.includes('INSERT INTO ai_organization_compaction_settings')) {
            const [organizationId, tailMode, summaryModel, revision, _actor, _createdAt, updatedAt] = params as [string, string | null, string | null, number, string, number, number];
            rows.set(organizationId, {
              tail_mode: tailMode,
              summary_model: summaryModel,
              revision,
              updated_at: updatedAt,
            });
          }
          return { changes: 1 };
        },
        close: async () => undefined,
      }),
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const {
      PiOrganizationCompactionSettingsConflictError,
      readPiOrganizationCompactionSettings,
      writePiOrganizationCompactionSettings,
    } = await import('../app/lib/pi/compaction/settings-store');

    assert.deepEqual(await readPiOrganizationCompactionSettings('org-a'), {
      configured: false,
      revision: 0,
      tailMode: null,
      summaryModel: null,
      updatedAt: null,
    });

    const first = await writePiOrganizationCompactionSettings({
      organizationId: 'org-a',
      actorUserId: 'admin-a',
      expectedRevision: 0,
      config: { tailMode: 'lean', summaryModel: 'aip_0123456789abcdef01234567/openai/gpt-5' },
    });
    assert.equal(first.revision, 1);
    assert.equal(first.tailMode, 'lean');
    assert.equal(first.summaryModel, 'aip_0123456789abcdef01234567/openai/gpt-5');
    assert.ok(calls.some((sql) => sql.includes('canvas_organization_settings') && sql.includes('FOR UPDATE')),
      'the organization row must serialize first writes that have no settings row yet');

    await assert.rejects(
      writePiOrganizationCompactionSettings({
        organizationId: 'org-a', actorUserId: 'admin-b', expectedRevision: 0,
        config: { tailMode: 'legacy', summaryModel: null },
      }),
      PiOrganizationCompactionSettingsConflictError,
      'a stale save must not overwrite the current organization setting',
    );

    const explicitMain = await writePiOrganizationCompactionSettings({
      organizationId: 'org-a', actorUserId: 'admin-a', expectedRevision: 1,
      config: { tailMode: 'legacy', summaryModel: null },
    });
    assert.deepEqual({
      revision: explicitMain.revision,
      tailMode: explicitMain.tailMode,
      summaryModel: explicitMain.summaryModel,
    }, { revision: 2, tailMode: 'legacy', summaryModel: null });

    const otherOrganization = await writePiOrganizationCompactionSettings({
      organizationId: 'org-b', actorUserId: 'admin-b', expectedRevision: 0,
      config: { tailMode: 'lean', summaryModel: null },
    });
    assert.equal(otherOrganization.revision, 1, 'organization settings must not share revisions or values');
    assert.equal((await readPiOrganizationCompactionSettings('org-a')).tailMode, 'legacy');
    assert.equal((await readPiOrganizationCompactionSettings('org-b')).tailMode, 'lean');
    console.log('pi-compaction-settings-store-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
