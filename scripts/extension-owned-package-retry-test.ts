import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

type Lease = { id: number; events: string[]; snapshotRead: boolean; serializable: boolean; errorCodes: string[] };
type Scenario = { leases: Lease[]; order: string[]; snapshot: (lease: Lease, attempt: number) => Promise<void>;
  afterRollback?: () => Promise<void>; rollbackFailure?: boolean; closeFailure?: boolean; commitFailure?: boolean };
const fault = (code: string) => Object.assign(new Error(`Controlled SQL transport fault ${code}`), { code });
const code = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

/** Genuine admission/package proofs and authority. Only explicit transport-fault
 * cases are injected; --native additionally forces a real snapshot/update/lock
 * serialization failure on the existing nonce-DB fixture, without a model. */
async function runOwnedPackageRetryRegression(): Promise<void> {
  const maintenanceUrl = process.env.DATABASE_URL;
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native: process.argv.includes('--native') });
  const databaseName = fixture.native ? String((await fixture.sql.get('SELECT current_database() AS name') as { name: string }).name) : '';
  const originalOpen = fixture.database.openDb;
  let scenario: Scenario | undefined, leaseSequence = 0, groups = 0;
  fixture.database.openDb = async (): Promise<SqlConnection> => {
    const selected = scenario;
    const lease: Lease = { id: ++leaseSequence, events: [], snapshotRead: false, serializable: false, errorCodes: [] };
    selected?.order.push(`checkout:${lease.id}`);
    const actual = await originalOpen();
    const read = async <T>(query: string, operation: () => T | Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        if (selected && lease.serializable && !lease.snapshotRead && query.includes('txid_current()')) {
          lease.snapshotRead = true; lease.events.push('snapshot');
          await selected.snapshot(lease, selected.leases.indexOf(lease) + 1);
        }
        return result;
      } catch (error) { if (lease.serializable) lease.errorCodes.push(code(error)); throw error; }
    };
    return { ...actual,
      get: (query, params) => read(query, () => actual.get(query, params)),
      all: (query, params) => read(query, () => actual.all(query, params)),
      run: async (query, params) => {
        if (selected && query === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
          lease.serializable = true; selected.leases.push(lease); lease.events.push('begin');
          selected.order.push(`begin:${lease.id}`);
        }
        if (lease.serializable && ['COMMIT', 'ROLLBACK'].includes(query)) lease.events.push(query.toLowerCase());
        const result = await actual.run(query, params);
        if (selected && lease.serializable && query === 'ROLLBACK') {
          await selected.afterRollback?.();
          if (selected.rollbackFailure) throw new Error('Controlled rollback acknowledgement loss.');
        }
        if (selected?.commitFailure && lease.serializable && query === 'COMMIT') throw fault('40001');
        return result;
      },
      close: async error => {
        if (lease.serializable) lease.events.push(error ? 'discard' : 'close');
        await actual.close(error);
        if (selected && lease.serializable) selected.order.push(`closed:${lease.id}`);
        if (selected?.closeFailure && lease.serializable) throw new Error('Controlled release failure.');
      },
    };
  };
  const withSql = async <T>(run: (database: SqlConnection) => T | Promise<T>): Promise<T> => {
    const database = await fixture.openObserverConnection();
    try { return await run(database); } finally { await database.close(); }
  };
  const closedBeforeNext = (value: Scenario) => {
    assert.equal(new Set(value.leases.map(lease => lease.id)).size, value.leases.length, 'Every attempt must own a fresh lease.');
    for (const lease of value.leases) assert(['close', 'discard'].includes(lease.events.at(-1)!), 'Every attempted lease must be closed.');
    const serializableIds = new Set(value.leases.map(lease => String(lease.id)));
    const serializableOrder = value.order.filter(event => serializableIds.has(event.split(':')[1]!));
    assert.deepEqual(serializableOrder, value.leases.flatMap(lease => [`checkout:${lease.id}`, `begin:${lease.id}`, `closed:${lease.id}`]),
      'A new attempt checkout must wait for the previous lease release; unrelated outside-frame reads are permitted.');
  };
  try {
    const management = await import('../app/lib/agents/management-actions');
    const admission = await import('../app/lib/pi/durable-message-admission');
    const sessions = await import('../app/lib/pi/session-workspace-context');
    const plugins = await import('../app/lib/plugins/canvas-plugin-registry');
    const stores = await import('../app/lib/capabilities/packages/store-actions');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const resourceStore = await import('../app/lib/capabilities/resources/store');
    const activation = await import('../app/lib/capabilities/packages/activation');
    const personalActivation = await import('../app/lib/capabilities/activation-actions');
    const runtime = await import('../app/lib/capabilities/packages/runtime-bindings');
    const turn = await import('../app/lib/capabilities/extensions/turn-runtime');
    const { owner, alice, organizationId } = fixture, actor = { ...owner, source: 'api' as const };
    await fixture.releaseSetupConnection();
    const agent = await management.createManagedAgent(actor, { name: `Package retry ${randomUUID()}`, scopeType: 'organization', enabledTools: ['read'],
      extensions: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' },
      grants: [{ targetType: 'user', targetId: alice.userId, canUse: true, canEdit: false, canManage: false }] });
    const sessionId = `package-retry-${randomUUID()}`;
    await withSql(database => database.run(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,provider,model,organization_id,workspace_id,workspace_type,created_at,updated_at)
      VALUES ($1,$2,$3,'fixture','fixture',$4,$5,'personal',1,1)`, [sessionId, alice.userId, agent.agent.agentId, organizationId, alice.workspaceId]));
    const base = await sessions.resolveAgentExecutionContextForStoredSession({ userId: alice.userId, sessionId, agentId: agent.agent.agentId });
    const name = `package-retry-${randomUUID().slice(0, 8)}`;
    const archive = await fixture.registry.addPackage('application', 'plugin', name, '1.0.0', {
      '.canvas-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0', skills: './skills', description: 'Actual immutable package retry source' }),
      'skills/retry-source/SKILL.md': '---\nname: retry-source\ndescription: Exact immutable source\n---\nRead only this selected source.\n',
    }, plugins.computeCanvasPluginChecksum);
    const grants = [owner, alice].map(value => ({ targetType: 'user' as const, targetId: value.userId, canUse: true, canEdit: false, canManage: false }));
    const installed = await stores.installCapabilityPackageFromStoreAction(owner, { source: { kind: 'plugin', registryId: 'store-application',
      entryKey: name, version: '1.0.0', checksum: archive.checksum }, ownership: { type: 'organization' }, grants });
    const pin = { resourceRef: installed.resource.resourceRef, publishedRevisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
    const descriptor = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
    await activation.setCapabilityPackageDefaultActivationAction(owner, pin.resourceRef, {
      expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state!.packageRevision, expectedPublishedRevisionRef: pin.publishedRevisionRef, expectedDefaultEnabled: false, enabled: true });
    await personalActivation.setPersonalCapabilityActivation({ context: { userId: alice.userId, organizationId, workspaceId: alice.workspaceId, role: 'member' },
      actorUserId: alice.userId, resourceId: descriptor.sourceStamp.resourceId, enabled: true });
    const identity = { userId: alice.userId, sessionId, clientMessageId: 'package-retry-original', expectedAgentId: agent.agent.agentId, expectedWorkspaceId: alice.workspaceId! };
    const prepared = await admission.prepareChatMessageAdmission({ ...identity, message: { role: 'user', content: 'Keep this exact immutable source.', timestamp: 1 },
      selection: { version: 1, origin: 'turn_reference', selections: [{ selection: { kind: 'plugin', package: pin, skillSelection: { kind: 'all' } }, requirement: 'optional', toolCap: null }] } });
    assert.equal(prepared.kind, 'prepared'); if (prepared.kind !== 'prepared') throw new Error('Actual preparation required.');
    const owned = await admission.commitPreparedChatMessageAdmission(prepared.admission);
    const original = admission.readOwnedChatMessageExecutionSnapshot(owned);
    assert(original.payload.extensionSelection);
    const context: AgentExecutionContext = { ...base, agentTurnId: original.payload.serverMessageId, turnExtensions: original.payload.extensionSelection.publicSelection };
    const preserved = JSON.stringify(original);
    const run = async (value: Scenario, reject?: (error: unknown) => boolean) => {
      assert.equal(scenario, undefined);
      const selection = await runtime.getAuthorizedAgentWorkflowPackageSelections(context);
      scenario = value;
      try {
        const execute = () => turn.reissueOwnedChatMessageRuntimeSelection(context, owned, { packageSelection: selection });
        if (reject) await assert.rejects(execute(), reject);
        else {
          const source = await execute(); assert(source);
          assert.deepEqual(turn.readAcceptedTurnRuntimeSelection(source, context, selection).publicSelection, original.payload.extensionSelection!.publicSelection);
        }
      } finally { scenario = undefined; }
      closedBeforeNext(value);
      const fresh = await admission.readOwnedAcceptedChatMessage(identity); assert(fresh);
      assert.equal(JSON.stringify(admission.readOwnedChatMessageExecutionSnapshot(fresh)), preserved, 'Metadata retries never mutate admission/execution state or renew intake.');
    };
    const controlled = (extra: Partial<Scenario> = {}): Scenario => ({ leases: [], order: [], snapshot: async (_lease, attempt) => { if (attempt === 1) throw fault('40001'); }, ...extra });
    const serializationConflict = async (_lease: Lease, attempt: number) => {
      if (attempt !== 1) return;
      if (!fixture.native) throw fault('40001');
      // txid_current() above has established this SERIALIZABLE snapshot. The
      // independent committed write must make the following FOR SHARE fail.
      await withSql(database => database.run('UPDATE canvas_organization_settings SET updated_at=updated_at+1 WHERE organization_id=$1', [organizationId]));
    };
    const one = controlled(); await run(one);
    assert.deepEqual(one.leases[0]!.events, ['begin', 'snapshot', 'rollback', 'close']);
    assert(one.leases.length > 1); assert(one.leases.slice(1).every(lease => lease.events.includes('commit'))); groups++;
    const exhausted = controlled({ snapshot: async () => { throw fault('40001'); } });
    await run(exhausted, error => code(error) === '40001'); assert.equal(exhausted.leases.length, 3);
    assert(exhausted.leases.every(lease => lease.events.includes('rollback') && !lease.events.includes('commit'))); groups++;
    for (const [label, value] of [
      ['deadlock', controlled({ snapshot: async () => { throw fault('40P01'); } })],
      ['rollback acknowledgement loss', controlled({ rollbackFailure: true })],
      ['release failure', controlled({ closeFailure: true })],
      ['commit acknowledgement loss', controlled({ snapshot: async () => {}, commitFailure: true })],
    ] as const) {
      await run(value, () => true); assert.equal(value.leases.length, 1, `${label} must never open a retry lease.`); groups++;
    }
    const denied = (error: unknown) => ['PACKAGE_ACCESS_DENIED', 'CAPABILITY_RESOURCE_ACCESS_DENIED', 'AGENT_EXTENSION_CONTEXT_DENIED'].includes(code(error));
    let revoked: Awaited<ReturnType<typeof resourceStore.mutateCapabilityResource>> | undefined;
    const grant = controlled({ snapshot: serializationConflict, afterRollback: async () => {
      if (revoked) return;
      const current = await packages.inspectCapabilityPackage(owner, pin.resourceRef);
      revoked = await resourceStore.mutateCapabilityResource(owner, pin.resourceRef, { expectedMetadataRevision: current.resource.metadataRevision,
        expectedGrantsRevision: current.resource.grantsRevision, grants: grants.filter(value => value.targetId === owner.userId) });
    } });
    try {
      await run(grant, denied); assert.equal(grant.leases.length, 2);
      assert(grant.leases[0]!.errorCodes.includes('40001')); groups++;
    }
    finally { if (revoked) await resourceStore.mutateCapabilityResource(owner, pin.resourceRef, { expectedMetadataRevision: revoked.metadata.metadataRevision,
      expectedGrantsRevision: revoked.metadata.grantsRevision, grants }); }
    let renamed = false;
    const revision = controlled({ snapshot: serializationConflict, afterRollback: async () => {
      if (renamed) return; renamed = true;
      const current = await management.inspectManagedAgent(actor, agent.agent.agentId);
      await management.updateManagedAgentProfile({ actor, agentId: agent.agent.agentId, expectedRevision: current.agent.revision, name: 'Changed after actual rollback' });
    } });
    await run(revision, denied); assert.equal(revision.leases.length, 2);
    assert(revision.leases[0]!.errorCodes.includes('40001')); groups++;

    if (fixture.native) {
      const native = controlled({ snapshot: serializationConflict });
      await run(native);
      assert(native.leases[0]!.errorCodes.includes('40001'), 'A real PG snapshot/update/FOR SHARE conflict, not an injected error, must occur.');
      assert.deepEqual(native.leases[0]!.events, ['begin', 'snapshot', 'rollback', 'close']);
      assert(native.leases.length > 1); assert(native.leases.slice(1).every(lease => lease.events.includes('commit'))); groups++;
    }
    assert.equal(fixture.providerRequests(), 0, 'No model/provider/business operation belongs to package freshness retry.');
    console.log(`PASS ${groups} ${fixture.native ? 'native PostgreSQL' : 'PGlite'} owned-package retry groups: genuine admission/source, fresh leases, bounded serialization recovery, current grants/revision, rollback/close/COMMIT failures; model/provider/business IO zero.${fixture.native ? ' Real snapshot/update/FOR SHARE SQLSTATE 40001 verified.' : ' Native concurrency is not claimed in PGlite mode.'}`);
  } finally {
    scenario = undefined; fixture.database.openDb = originalOpen;
    await fixture.close(); await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' });
    if (fixture.native) {
      assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
      const observer = new Pool({ connectionString: maintenanceUrl, max: 1 });
      try { assert.equal((await observer.query('SELECT COUNT(*)::integer AS count FROM pg_database WHERE datname=$1', [databaseName])).rows[0].count, 0); }
      finally { await observer.end(); }
    }
  }
}

runOwnedPackageRetryRegression().catch(error => { console.error(error); process.exitCode = 1; });
