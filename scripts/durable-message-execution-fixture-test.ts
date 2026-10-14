import assert from 'node:assert/strict';
import { createDurableMessageExecutionFixture } from './helpers/durable-message-execution-fixture';

/** Real PGlite schema/ACL/catalog/session/Runtime registration, local GET-only
 * Ollama metadata. No model generation, queue dispatch or execution claim. */
async function main(): Promise<void> {
  const fixture = await createDurableMessageExecutionFixture();
  try {
    const owner = await fixture.createSessionRuntime();
    const ownerProof = await fixture.runtimeApi.getRegisteredPiRuntimeExecutionOwner(owner.runtime);
    const ownerData = await fixture.runtimeApi.readRegisteredPiRuntimeExecutionOwner(ownerProof);
    assert.equal(ownerData.userId, owner.userId); assert.equal(ownerData.sessionId, owner.sessionId);
    assert.equal(ownerData.agentId, owner.agentId); assert.equal(ownerData.workspaceId, owner.context.workspaceId);
    await assert.rejects(fixture.runtimeApi.readRegisteredPiRuntimeExecutionOwner({ ...ownerProof }));
    const reused = await fixture.createSessionRuntime({ userId: owner.userId, sessionId: owner.sessionId, agentId: owner.agentId });
    assert.equal(reused.runtime, owner.runtime);
    assert.equal(await fixture.runtimeApi.getRegisteredPiRuntimeExecutionOwner(reused.runtime), ownerProof);
    const alice = await fixture.createSessionRuntime({ userId: 'alice', agentId: owner.agentId });
    assert.notEqual(alice.runtime, owner.runtime); assert.equal(alice.context.userId, 'alice');
    assert.equal(alice.context.workspaceId, fixture.application.alice.workspaceId);
    const aliceProof = await fixture.runtimeApi.getRegisteredPiRuntimeExecutionOwner(alice.runtime);
    assert.notEqual((await fixture.runtimeApi.readRegisteredPiRuntimeExecutionOwner(aliceProof)).token, ownerData.token);
    await fixture.runtimeApi.invalidatePiRuntime(owner.sessionId, owner.userId);
    assert.equal(await fixture.runtimeApi.getExistingPiRuntime(owner.sessionId, owner.userId), null);
    await assert.rejects(fixture.runtimeApi.readRegisteredPiRuntimeExecutionOwner(ownerProof));
    const replacement = await fixture.createSessionRuntime({ userId: owner.userId, sessionId: owner.sessionId, agentId: owner.agentId });
    assert.notEqual(replacement.runtime, owner.runtime); assert.equal(replacement.runtime.getStatus().phase, 'idle');
    const replacementProof = await fixture.runtimeApi.getRegisteredPiRuntimeExecutionOwner(replacement.runtime);
    assert.notEqual((await fixture.runtimeApi.readRegisteredPiRuntimeExecutionOwner(replacementProof)).token, ownerData.token);
    const database = await fixture.application.database.openDb();
    try {
      const sessions = await database.all('SELECT user_id,agent_id,provider,model,runtime_provider_installation_id FROM pi_sessions');
      assert.equal(sessions.length, 2);
      for (const session of sessions as Array<Record<string, unknown>>) {
        assert.equal(session.agent_id, owner.agentId); assert.equal(session.provider, fixture.model.providerId);
        assert.equal(session.model, fixture.model.modelId); assert.equal(session.runtime_provider_installation_id, fixture.model.providerInstallationId);
      }
      assert.equal((await database.get('SELECT count(*)::integer AS count FROM pi_messages') as { count: number }).count, 0);
      assert.equal((await database.get('SELECT count(*)::integer AS count FROM file_agent_turns') as { count: number }).count, 0);
    } finally { await database.close(); }
    assert.deepEqual(fixture.counts(), { catalogReads: 1, forbiddenModelRequests: 0, externalRequests: 0 });
    console.log('PASS durable execution fixture (actual PGlite): real catalog/credential bootstrap, Agent and runtime-pinned sessions, genuine registered Owner reuse/clone denial/eviction/replacement token, separate Use-only actor; metadata GET=1, model/business requests=0, transcript/turn execution=0.');
  } finally { await fixture.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
