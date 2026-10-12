import assert from 'node:assert/strict';
import Module from 'node:module';
import { IntegrationReferenceCache } from '../app/lib/integration-tools/reference-cache';
import type { IntegrationUncertainTurnContext } from '../app/lib/integration-tools/uncertain-turns';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const database = await createPiTestDatabase();
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = internals._load;
  const host = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: IntegrationReferenceCache<boolean> };
  const previousCache = host.__canvasIntegrationUncertainTurnsV1;
  let now = 1234;
  host.__canvasIntegrationUncertainTurnsV1 = new IntegrationReferenceCache<boolean>(512, 15 * 60_000, () => now);
  internals._load = (name, parent, isMain) => {
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return database;
    return originalLoad(name, parent, isMain);
  };
  const storePath = require.resolve('../app/lib/integration-tools/uncertain-turn-store');
  const cachePath = require.resolve('../app/lib/integration-tools/uncertain-turns');
  try {
    const raw = await database.openDb();
    // The production reflected migration upgrades an existing DB without changing its runner.
    await raw.run('DROP TABLE integration_turn_outcomes');
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    await raw.run('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$1,$2,1,1,1)',
      ['uncertain-actor', 'uncertain-actor@example.test']);
    const context: IntegrationUncertainTurnContext = {
      userId: 'uncertain-actor', sessionId: 'parent-session', agentId: 'canvas-agent', workspaceId: 'workspace-a', agentTurnId: 'human-turn-a',
    };
    const sync = await import('../app/lib/integration-tools/uncertain-turns');
    let service = await import('../app/lib/integration-tools/uncertain-turn-store');
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), false);
    await service.persistIntegrationTurnUncertain(context);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), true);
    assert.equal(sync.isIntegrationTurnUncertain(context), true);
    const first = await raw.get('SELECT * FROM integration_turn_outcomes') as Record<string, unknown>;
    await service.persistIntegrationTurnUncertain(context);
    assert.equal((await raw.all('SELECT * FROM integration_turn_outcomes')).length, 1, 'duplicate results never reopen or rewrite the outcome');
    assert.deepEqual(await raw.get('SELECT * FROM integration_turn_outcomes'), first);
    assert.deepEqual(Object.keys(first).sort(), ['binding_key', 'actor_user_id', 'session_id', 'agent_identity', 'workspace_id', 'agent_turn_id', 'outcome', 'created_at'].sort());
    assert.equal(first.outcome, 'outcome_unknown');
    for (const field of ['userId', 'sessionId', 'agentId', 'workspaceId', 'agentTurnId'] as const) {
      assert.equal(await service.isPersistedIntegrationTurnUncertain({ ...context, [field]: `other-${field}` }), false);
    }
    assert.equal(await service.isPersistedIntegrationTurnUncertain({ ...context, agentTurnId: 'new-explicit-human-turn' }), false);
    assert.equal(await service.isPersistedIntegrationTurnUncertain({ ...context, agentTurnId: undefined }), false);
    const mutable = { ...context, agentTurnId: 'captured-before-await' };
    const persistence = service.persistIntegrationTurnUncertain(mutable);
    mutable.workspaceId = 'changed-after-start';
    await persistence;
    assert.equal(await service.isPersistedIntegrationTurnUncertain(mutable), false);
    assert.equal(await service.isPersistedIntegrationTurnUncertain({ ...mutable, workspaceId: context.workspaceId }), true);
    const noTurn = { ...context, agentId: null, agentTurnId: undefined };
    await service.persistIntegrationTurnUncertain(noTurn);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(noTurn), true, 'legacy contexts without a turn stay exactly scoped');
    now += 15 * 60_000;
    assert.equal(sync.isIntegrationTurnUncertain(context), false);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), true, 'TTL expiry must never release a queued task');
    for (let index = 0; index <= 512; index += 1) sync.markIntegrationTurnUncertain({ ...context, agentTurnId: `capacity-${index}` });
    assert.equal(sync.isIntegrationTurnUncertain(context), false);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), true);
    // Simulate fresh server modules and an empty process cache; only PG remains.
    delete require.cache[storePath];
    delete require.cache[cachePath];
    delete host.__canvasIntegrationUncertainTurnsV1;
    service = internals._load(storePath, module, false) as typeof service;
    const freshCache = internals._load(cachePath, module, false) as typeof sync;
    assert.equal(freshCache.isIntegrationTurnUncertain(context), false);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), true);
    assert.equal(await service.isPersistedIntegrationTurnUncertain({ ...context, agentTurnId: 'new-explicit-human-turn' }), false);
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.equal(await service.isPersistedIntegrationTurnUncertain(context), true, 'idempotent startup migration preserves durable outcomes');
    await assert.rejects(raw.run('UPDATE integration_turn_outcomes SET outcome=$1', ['success']), /check constraint/);
    await assert.rejects(service.persistIntegrationTurnUncertain({ ...context, userId: '' }), /server-bound/);
    console.log('PASS durable integration uncertainty: reflected PG upgrade, exact immutable identities, idempotency, TTL/eviction/restart, next human turn, no payload storage');
  } finally {
    internals._load = originalLoad;
    if (previousCache) host.__canvasIntegrationUncertainTurnsV1 = previousCache;
    else delete host.__canvasIntegrationUncertainTurnsV1;
    delete require.cache[storePath];
    delete require.cache[cachePath];
    await database.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
