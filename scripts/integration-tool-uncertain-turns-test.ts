import assert from 'node:assert/strict';
import Module from 'node:module';
import { IntegrationReferenceCache } from '../app/lib/integration-tools/reference-cache';
import { schemaFingerprint } from '../app/lib/integration-tools/schema';
import type { IntegrationUncertainTurnContext } from '../app/lib/integration-tools/uncertain-turns';

async function main() {
  const host = globalThis as typeof globalThis & { __canvasIntegrationUncertainTurnsV1?: IntegrationReferenceCache<boolean> };
  const previous = host.__canvasIntegrationUncertainTurnsV1;
  let now = 1234;
  const cache = new IntegrationReferenceCache<boolean>(512, 15 * 60_000, () => now);
  host.__canvasIntegrationUncertainTurnsV1 = cache;
  const context: IntegrationUncertainTurnContext = {
    userId: 'actor-a', sessionId: 'parent-session', agentId: 'canvas-agent', workspaceId: 'workspace-a', agentTurnId: 'human-turn-a',
  };
  const previousKey = schemaFingerprint([context.userId, context.sessionId, context.agentId, context.workspaceId, context.agentTurnId ?? null]);
  cache.set(previousKey, true);
  const servicePath = require.resolve('../app/lib/integration-tools/uncertain-turns');
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  try {
    const service = await import('../app/lib/integration-tools/uncertain-turns');
    assert.equal(host.__canvasIntegrationUncertainTurnsV1, cache, 'the original global cache must be preserved');
    assert.equal(service.isIntegrationTurnUncertain(context), true, 'old factory-issued marks remain readable with the exact same key');
    for (const field of ['userId', 'sessionId', 'agentId', 'workspaceId', 'agentTurnId'] as const) {
      assert.equal(service.isIntegrationTurnUncertain({ ...context, [field]: 'other-' + field }), false);
    }
    assert.equal(service.isIntegrationTurnUncertain({ ...context, agentTurnId: undefined }), false);
    const noTurn = { ...context, agentId: null, agentTurnId: undefined };
    service.markIntegrationTurnUncertain(noTurn);
    assert.equal(cache.get(schemaFingerprint([noTurn.userId, noTurn.sessionId, null, noTurn.workspaceId, null])), true);
    const mutable = { ...context, sessionId: 'worker-session', agentTurnId: 'worker-turn' };
    service.markIntegrationTurnUncertain(mutable);
    mutable.userId = 'different-after-mark';
    assert.equal(service.isIntegrationTurnUncertain(mutable), false);
    assert.equal(service.isIntegrationTurnUncertain({ ...mutable, userId: context.userId }), true);
    delete require.cache[servicePath];
    const copy = internals._load(servicePath, module, false) as typeof service;
    assert.equal(copy.isIntegrationTurnUncertain(context), true, 'module reloads must see the same quarantine');
    assert.equal(copy.isIntegrationTurnUncertain({ ...context, agentTurnId: 'new-explicit-human-turn' }), false);
    now += 15 * 60_000;
    assert.equal(copy.isIntegrationTurnUncertain(context), false, 'expiry keeps the original bounded in-process behavior');
    for (let index = 0; index <= 512; index += 1) copy.markIntegrationTurnUncertain({ ...context, agentTurnId: `bounded-${index}` });
    assert.equal(cache.size, 512);
    assert.equal(copy.isIntegrationTurnUncertain({ ...context, agentTurnId: 'bounded-0' }), false);
    assert.equal(copy.isIntegrationTurnUncertain({ ...context, agentTurnId: 'bounded-512' }), true);
    console.log('PASS shared integration uncertainty: exact legacy/global keys, full identity isolation, new human turn, module reload, TTL and capacity');
  } finally {
    if (previous) host.__canvasIntegrationUncertainTurnsV1 = previous;
    else delete host.__canvasIntegrationUncertainTurnsV1;
    delete require.cache[servicePath];
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
