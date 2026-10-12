import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

import type { AgentManagementActor } from '../app/lib/agents/management-actions';
import type { SqlConnection } from '../app/lib/db';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';

type AgentSnapshot = {
  profile: Record<string, unknown>;
  bindings: Record<string, unknown>[];
  grants: Record<string, unknown>[];
};

async function waitForAgentLockWaiters(database: SqlConnection, count: number): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await database.all(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND state = 'active' AND wait_event_type = 'Lock'
         AND lower(query) LIKE '%agents%' AND cardinality(pg_blocking_pids(pid)) > 0`,
    ) as Array<{ pid: number }>;
    if (rows.length >= count) return [...new Set(rows.map(row => row.pid))];
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Expected ${count} actual PostgreSQL agent-row lock waiters.`);
}

async function snapshot(database: SqlConnection, agentId: string): Promise<AgentSnapshot> {
  const profile = await database.get('SELECT * FROM agents WHERE agent_id = $1', [agentId]) as Record<string, unknown>;
  assert(profile);
  return {
    profile,
    bindings: await database.all('SELECT * FROM agent_capability_bindings WHERE agent_id = $1 ORDER BY resource_id', [agentId]) as Record<string, unknown>[],
    grants: await database.all('SELECT * FROM agent_grants WHERE agent_id = $1 ORDER BY target_type, target_id', [agentId]) as Record<string, unknown>[],
  };
}

function rejectedCode(result: PromiseSettledResult<unknown>): string | undefined {
  return result.status === 'rejected' && result.reason && typeof result.reason === 'object'
    ? Reflect.get(result.reason, 'code') as string | undefined : undefined;
}

function isTransportFailure(error: unknown): boolean {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '08000', '08003', '08006', 'postgres_unavailable']);
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if (codes.has(String(Reflect.get(current, 'code')))) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'This gate requires real managed PostgreSQL, without PGlite fallback.');
  const originalDatabaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(originalDatabaseUrl.hostname, '127.0.0.1');
  assert.equal(originalDatabaseUrl.port, '55433');
  assert.equal(originalDatabaseUrl.search, '');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-foundation-native-'));
  await fs.chmod(root, 0o700);
  const marker = randomBytes(16).toString('hex');
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600 });
  const fixture = await createSharedConnectionTestDatabase();
  assert(fixture.native);
  const observer = await fixture.openDb();
  const identity = await observer.get('SELECT current_database() AS name, pg_backend_pid() AS pid') as { name: string; pid: number };
  assert.match(identity.name, /^canvas_connection_test_[a-f0-9]{32}$/u);
  const runtimeUrl = new URL(originalDatabaseUrl); runtimeUrl.pathname = `/${identity.name}`;
  const env = {
    DATABASE_URL: runtimeUrl.toString(), DATA: root, CANVAS_DATA_ROOT: root, CANVAS_APP_ROOT: process.cwd(),
    CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_POOL_MAX: '8',
    CANVAS_ORGANIZATION_ID: 'org-agent-foundation', CANVAS_DEPLOYMENT_MODE: 'team',
    BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false',
    CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: '', CANVAS_INSTANCE_ID: `foundation-${marker}`,
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const realModules = new Map<string, unknown>();
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (realModules.has(name)) return realModules.get(name);
    return originalLoad(name, parent, isMain);
  };
  let closeRuntime: (() => Promise<void>) | undefined;
  let locker: SqlConnection | undefined;
  let preserveData = false;
  try {
    realModules.set('@earendil-works/pi-agent-core', await import('@earendil-works/pi-agent-core'));
    realModules.set('@earendil-works/pi-ai', await import('@earendil-works/pi-ai'));
    realModules.set('@earendil-works/pi-ai/compat', await import('@earendil-works/pi-ai/compat'));
    realModules.set('@earendil-works/pi-ai/oauth', await import('@earendil-works/pi-ai/oauth'));
    const runtime = await import('../app/lib/db');
    closeRuntime = runtime.closeDatabaseConnections;
    const runtimePool = runtime.getPostgresRuntimeQueryable(); assert(runtimePool);
    assert.equal(runtimePool.options.max, 8);
    assert.equal((await runtimePool.query('SELECT current_database() AS name')).rows[0].name, identity.name);
    const { createInitialOwner } = await import('../app/lib/auth-setup');
    const password = randomBytes(30).toString('base64url');
    const owner = await createInitialOwner({ name: 'Foundation Owner', email: 'owner@agent-foundation.example.test', password });
    const org = 'org-agent-foundation';
    const users = ['manager', 'team-member', 'project-member', 'nonmember', 'grant-target', 'rollback-target'];
    for (const id of users) {
      await observer.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@agent-foundation.example.test`]);
      await observer.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ($1,$2,'member','active',0,1000,1000)", [org, id]);
    }
    await observer.run("INSERT INTO canvas_projects (id,organization_id,name,slug,status,created_by_user_id,created_at,updated_at) VALUES ('foundation-project',$1,'Foundation project','foundation-project','active','manager',1000,1000)", [org]);
    await observer.run("INSERT INTO canvas_workspaces (id,organization_id,type,project_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ('foundation-team',$1,'team',NULL,'teams/foundation/files','Foundation team','active',1000,1000),('foundation-project-workspace',$1,'project','foundation-project','projects/foundation/files','Foundation project','active',1000,1000)", [org]);
    await observer.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ($1,'foundation-team','team-member','member','active',1,1,0,1000,1000)", [org]);
    await observer.run("INSERT INTO canvas_project_members (organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at) VALUES ($1,'foundation-project','project-member','member','active',1,1,0,1000,1000)", [org]);
    const registry = await import('../app/lib/agents/registry');
    const management = await import('../app/lib/agents/management-actions');
    const grants = await import('../app/lib/agents/grants');
    const bindings = await import('../app/lib/agents/capability-bindings');
    const access = await import('../app/lib/agents/access');
    const manager: AgentManagementActor = { userId: 'manager', organizationId: org, source: 'api' };
    let nextId = 0;
    const createAgent = async (suffix: string, ownerUserId?: string) => {
      const profile = await registry.createAgentProfile({ agentId: `foundation-${++nextId}-${suffix}`, name: `Foundation ${suffix}`,
        scopeType: ownerUserId ? 'user' : 'organization', organizationId: org, ownerUserId: ownerUserId ?? null,
        createdByUserId: 'manager', accessPolicy: 'restricted', relevantConnections: ['baseline-connection'] });
      if (!ownerUserId) await grants.upsertAgentGrant({ agentId: profile.agentId, organizationId: org, targetType: 'user', targetId: 'manager', actorUserId: 'manager', canUse: true, canEdit: true, canManage: true });
      await bindings.replaceAgentCapabilityBindings(profile.agentId, [{ resourceType: 'connection', scopeType: 'user', resourceId: 'connection:baseline-connection', name: 'baseline-connection', version: 'runtime' }]);
      return profile;
    };
    const holdAgent = async (agentId: string) => {
      locker = await runtime.openDb();
      await locker.run('BEGIN');
      await locker.get('SELECT agent_id FROM agents WHERE agent_id = $1 FOR UPDATE', [agentId]);
    };
    const releaseAgent = async () => { assert(locker); await locker.run('COMMIT'); await locker.close(); locker = undefined; };
    const race = async <T>(agentId: string, calls: Array<() => Promise<T>>) => {
      await holdAgent(agentId);
      const queued = Promise.allSettled(calls.map(call => call()));
      const observed = await waitForAgentLockWaiters(observer, calls.length);
      assert.equal(observed.length, calls.length, 'Independent actual PostgreSQL backend clients contend for the row.');
      await releaseAgent();
      const results = await queued;
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => rejectedCode(result) === 'AGENT_REVISION_CONFLICT').length, calls.length - 1);
      for (const result of results) if (result.status === 'rejected') assert.equal(management.managementErrorDetails(result.reason).status, 409);
      const fulfilled = results.find(result => result.status === 'fulfilled'); assert(fulfilled?.status === 'fulfilled');
      return fulfilled.value;
    };
    const direct = await createAgent('profile-cas');
    const directWinner = await race(direct.agentId, ['Profile one', 'Profile two'].map(name => () => registry.updateAgentProfile({ agentId: direct.agentId, expectedRevision: 1, name })));
    const directStored = await registry.getAgentProfile(direct.agentId);
    assert.equal(directWinner.revision, 2); assert.equal(directStored?.name, directWinner.name); assert.equal(directStored?.revision, 2);
    const coupled = await createAgent('capability-cas');
    const coupledWinner = await race(coupled.agentId, ['winner-one', 'winner-two'].map(name => () => management.updateManagedAgentCapabilities({ actor: manager, agentId: coupled.agentId, expectedRevision: 1, relevantConnections: [name], relevantSkills: [], capabilities: [] })));
    const coupledStored = await registry.getAgentProfile(coupled.agentId), coupledBindings = await bindings.listAgentCapabilityBindings(coupled.agentId);
    assert.deepEqual(coupledStored?.relevantConnections, coupledWinner.agent.relevantConnections);
    assert.equal(coupledStored?.revision, 2); assert.deepEqual(coupledBindings, coupledWinner.bindings);
    assert.deepEqual(coupledBindings.map(binding => binding.name), coupledStored?.relevantConnections);
    console.log('PASS actual 8-client runtime PostgreSQL: one profile CAS winner, one 409; capability bindings and profile retain exactly the same winner.');

    const pressure = await createAgent('pool-eight-pressure');
    locker = await fixture.openDb();
    await locker.run('BEGIN');
    await locker.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR UPDATE', [pressure.agentId]);
    const pressureStartedAt = Date.now();
    const pressureResults = Promise.allSettled(Array.from({ length: 8 }, (_, index) => management.updateManagedAgentCapabilities({
      actor: manager, agentId: pressure.agentId, expectedRevision: 1,
      relevantConnections: [`pressure-winner-${index}`], capabilities: [], relevantSkills: [],
    })));
    const pressureWaiters = await waitForAgentLockWaiters(observer, 8);
    assert.equal(pressureWaiters.length, 8, 'All eight actual runtime backend clients reach the agent row; locker and observer use a separate native pool.');
    assert.equal(runtimePool.totalCount, 8); assert.equal(runtimePool.waitingCount, 0);
    await releaseAgent();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const pressureSettled = await Promise.race([
      pressureResults,
      new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error('Native eight-client pressure gate exceeded its post-release deadline.')), 10_000); }),
    ]).finally(() => { if (deadlineTimer) clearTimeout(deadlineTimer); });
    assert(Date.now() - pressureStartedAt < 20_000, 'The actual pool-pressure mutation batch completes within the test observation deadline.');
    assert.equal(pressureSettled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(pressureSettled.filter(result => rejectedCode(result) === 'AGENT_REVISION_CONFLICT').length, 7);
    for (const result of pressureSettled) if (result.status === 'rejected') assert.equal(management.managementErrorDetails(result.reason).status, 409);
    const pressureWinner = pressureSettled.find(result => result.status === 'fulfilled'); assert(pressureWinner?.status === 'fulfilled');
    const pressureStored = await registry.getAgentProfile(pressure.agentId);
    assert.equal(pressureStored?.revision, 2);
    assert.deepEqual(pressureStored?.relevantConnections, pressureWinner.value.agent.relevantConnections);
    assert.deepEqual(await bindings.listAgentCapabilityBindings(pressure.agentId), pressureWinner.value.bindings);
    assert.deepEqual(pressureWinner.value.bindings.map(binding => binding.name), pressureStored?.relevantConnections);
    console.log('PASS native max8 saturation: eight observed agent-row waiters, independent external locker, one complete profile/binding winner and seven revision409s within a bounded observation deadline.');

    await observer.run(`CREATE FUNCTION foundation_reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'reject-inner-binding' THEN RAISE EXCEPTION 'fixture binding failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`);
    await observer.run('CREATE TRIGGER foundation_binding_failure BEFORE INSERT ON agent_capability_bindings FOR EACH ROW EXECUTE FUNCTION foundation_reject_binding()');
    const failing = await createAgent('binding-failure'), failingBefore = await snapshot(observer, failing.agentId);
    await assert.rejects(() => management.updateManagedAgentCapabilities({ actor: manager, agentId: failing.agentId, expectedRevision: 1, relevantConnections: ['reject-inner-binding'], relevantSkills: [], capabilities: [] }), { code: 'P0001' });
    assert.deepEqual(await snapshot(observer, failing.agentId), failingBefore);

    const setRacer = await createAgent('set-grant-cas');
    const setWinner = await race(setRacer.agentId, [false, true].map(canEdit => () => management.setManagedAgentGrant({ actor: manager, agentId: setRacer.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target', canUse: true, canEdit, canManage: false })));
    assert.equal(setWinner.agent.revision, 2);
    assert.deepEqual((await grants.listAgentGrants(setRacer.agentId)).find(grant => grant.targetId === 'grant-target'), setWinner.grant);
    const mixedRacer = await createAgent('set-remove-cas');
    await grants.upsertAgentGrant({ agentId: mixedRacer.agentId, organizationId: org, targetType: 'user', targetId: 'grant-target', actorUserId: 'manager', canUse: true, canEdit: false, canManage: false });
    type MixedWinner = { kind: 'set'; value: Awaited<ReturnType<typeof management.setManagedAgentGrant>> } | { kind: 'remove'; value: Awaited<ReturnType<typeof management.removeManagedAgentGrant>> };
    const mixedWinner = await race<MixedWinner>(mixedRacer.agentId, [
      () => management.setManagedAgentGrant({ actor: manager, agentId: mixedRacer.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target', canUse: true, canEdit: true, canManage: false }).then(value => ({ kind: 'set' as const, value })),
      () => management.removeManagedAgentGrant({ actor: manager, agentId: mixedRacer.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target' }).then(value => ({ kind: 'remove' as const, value })),
    ]);
    const mixedGrant = (await grants.listAgentGrants(mixedRacer.agentId)).find(grant => grant.targetId === 'grant-target');
    if (mixedWinner.kind === 'set') assert.deepEqual(mixedGrant, mixedWinner.value.grant); else assert.equal(mixedGrant, undefined);
    assert.equal((await registry.getAgentProfile(mixedRacer.agentId))?.revision, 2);
    const removeRacer = await createAgent('remove-grant-cas');
    await grants.upsertAgentGrant({ agentId: removeRacer.agentId, organizationId: org, targetType: 'user', targetId: 'grant-target', actorUserId: 'manager', canUse: true });
    const removeWinner = await race(removeRacer.agentId, [1, 2].map(() => () => management.removeManagedAgentGrant({ actor: manager, agentId: removeRacer.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target' })));
    assert.equal(removeWinner.removed, true); assert.equal((await grants.listAgentGrants(removeRacer.agentId)).some(grant => grant.targetId === 'grant-target'), false);

    await observer.run(`CREATE FUNCTION foundation_reject_profile() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name LIKE 'Foundation fail-profile-%' THEN RAISE EXCEPTION 'fixture profile failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`);
    await observer.run('CREATE TRIGGER foundation_profile_failure BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION foundation_reject_profile()');
    for (const kind of ['capability', 'set-new', 'set-existing', 'remove'] as const) {
      const agent = await createAgent(`fail-profile-${kind}`);
      if (kind === 'set-existing' || kind === 'remove') await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: org, targetType: 'user', targetId: 'grant-target', actorUserId: 'manager', canUse: true, canEdit: false });
      const before = await snapshot(observer, agent.agentId);
      const call = kind === 'capability' ? () => management.updateManagedAgentCapabilities({ actor: manager, agentId: agent.agentId, expectedRevision: 1, relevantConnections: ['must-rollback'], capabilities: [], relevantSkills: [] })
        : kind === 'remove' ? () => management.removeManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target' })
          : () => management.setManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target', canUse: true, canEdit: true });
      await assert.rejects(call, { code: 'P0001' }); assert.deepEqual(await snapshot(observer, agent.agentId), before);
    }
    await observer.run('DROP TRIGGER foundation_profile_failure ON agents');
    await observer.run(`CREATE FUNCTION foundation_reject_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF TG_OP = 'DELETE' THEN
        IF OLD.target_id = 'rollback-target' THEN RAISE EXCEPTION 'fixture grant failure' USING ERRCODE = 'P0001'; END IF; RETURN OLD;
      END IF;
      IF NEW.target_id = 'rollback-target' THEN RAISE EXCEPTION 'fixture grant failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$`);
    for (const kind of ['insert', 'update', 'delete'] as const) {
      const agent = await createAgent(`fail-grant-${kind}`);
      if (kind !== 'insert') await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: org, targetType: 'user', targetId: 'rollback-target', actorUserId: 'manager', canUse: true });
      await observer.run(`CREATE TRIGGER foundation_grant_failure BEFORE ${kind.toUpperCase()} ON agent_grants FOR EACH ROW EXECUTE FUNCTION foundation_reject_grant()`);
      const before = await snapshot(observer, agent.agentId);
      const call = kind === 'delete' ? () => management.removeManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'rollback-target' })
        : () => management.setManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'rollback-target', canUse: true, canEdit: true });
      await assert.rejects(call, { code: 'P0001' }); assert.deepEqual(await snapshot(observer, agent.agentId), before);
      await observer.run('DROP TRIGGER foundation_grant_failure ON agent_grants');
    }
    console.log('PASS native rollback matrix: binding insert and grant insert/update/delete failures, plus failed profile updates preserve every prior row; grant set/remove races have one winner.');

    for (const operation of ['capabilities', 'set', 'remove'] as const) {
      const agent = await createAgent(`revoke-${operation}`);
      if (operation === 'remove') await grants.upsertAgentGrant({ agentId: agent.agentId, organizationId: org, targetType: 'user', targetId: 'grant-target', actorUserId: 'manager', canUse: true });
      const before = await snapshot(observer, agent.agentId);
      await holdAgent(agent.agentId);
      const queued = operation === 'capabilities' ? management.updateManagedAgentCapabilities({ actor: manager, agentId: agent.agentId, expectedRevision: 1, relevantConnections: ['revoked-must-not-write'], capabilities: [], relevantSkills: [] })
        : operation === 'set' ? management.setManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target', canUse: true, canEdit: true })
          : management.removeManagedAgentGrant({ actor: manager, agentId: agent.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target' });
      const outcome = queued.then(value => ({ value }), error => ({ error }));
      await waitForAgentLockWaiters(observer, 1);
      assert(locker);
      await locker.run("DELETE FROM agent_grants WHERE agent_id=$1 AND target_type='user' AND target_id='manager'", [agent.agentId]);
      await releaseAgent();
      const result = await outcome; assert('error' in result); assert.equal(management.managementErrorDetails(result.error).status, 403);
      const after = await snapshot(observer, agent.agentId);
      assert.deepEqual(after.profile, before.profile); assert.deepEqual(after.bindings, before.bindings);
      assert.deepEqual(after.grants, before.grants.filter(grant => grant.target_id !== 'manager'));
    }
    console.log('PASS observed PostgreSQL row-lock waits: capability, grant set and grant remove reread revoked authority and dispatch zero configuration writes.');

    const teamAgent = await createAgent('team-access'), projectAgent = await createAgent('project-access');
    await grants.upsertAgentGrant({ agentId: teamAgent.agentId, organizationId: org, targetType: 'workspace', targetId: 'foundation-team', actorUserId: 'manager', canUse: true, canEdit: true, canManage: false });
    await grants.upsertAgentGrant({ agentId: projectAgent.agentId, organizationId: org, targetType: 'project', targetId: 'foundation-project', actorUserId: 'manager', canUse: true, canEdit: true, canManage: false });
    for (const [agentId, workspaceId, projectId] of [[teamAgent.agentId, 'foundation-team', null], [projectAgent.agentId, 'foundation-project-workspace', 'foundation-project'], [projectAgent.agentId, null, 'foundation-project']] as const) {
      const forged = { userId: 'nonmember', organizationId: org, workspaceId, projectId };
      assert.deepEqual(await access.getAgentAccess('nonmember', agentId, forged), { canUse: false, canEdit: false, canManage: false });
      const before = await snapshot(observer, agentId);
      await assert.rejects(() => management.updateManagedAgentCapabilities({ actor: forged, agentId, expectedRevision: 1, relevantConnections: ['forged-never-written'], capabilities: [], relevantSkills: [] }), error => management.managementErrorDetails(error).status === 403);
      assert.deepEqual(await snapshot(observer, agentId), before);
    }
    for (const [agentId, actor] of [[teamAgent.agentId, { userId: 'team-member', organizationId: org, workspaceId: 'foundation-team' }], [projectAgent.agentId, { userId: 'project-member', organizationId: org, workspaceId: 'foundation-project-workspace', projectId: 'foundation-project' }]] as const) {
      assert.equal((await access.getAgentAccess(actor.userId, agentId, { organizationId: actor.organizationId, workspaceId: actor.workspaceId, projectId: 'projectId' in actor ? actor.projectId : undefined })).canEdit, true);
      assert.equal((await access.getAgentAccess(actor.userId, agentId)).canEdit, true, 'Missing execution context still aggregates actual memberships, without trusting supplied IDs.');
      const changed = await management.updateManagedAgentCapabilities({ actor, agentId, expectedRevision: 1, relevantConnections: ['legitimate-connection'], capabilities: [], relevantSkills: [] });
      assert.equal(changed.agent.revision, 2);
    }
    const personal = await createAgent('personal', 'nonmember');
    assert.equal((await access.getAgentAccess('nonmember', personal.agentId)).canManage, true);
    assert.equal((await management.updateManagedAgentCapabilities({ actor: { userId: 'nonmember' }, agentId: personal.agentId, expectedRevision: 1, relevantConnections: [], capabilities: [], relevantSkills: [] })).agent.revision, 2);
    const legacy = await registry.createAgentProfile({ agentId: 'foundation-legacy', name: 'Foundation legacy', accessPolicy: 'legacy', scopeType: 'user' });
    assert.deepEqual(await access.getAgentAccess('nonmember', legacy.agentId), { canUse: true, canEdit: true, canManage: true });
    assert.equal((await management.updateManagedAgentCapabilities({ actor: { userId: 'nonmember' }, agentId: legacy.agentId, expectedRevision: 1, relevantConnections: [], capabilities: [], relevantSkills: [] })).agent.revision, 2);

    const authModule = await import('../app/lib/auth');
    await authModule.ensureAuthReady();
    const signedIn = await authModule.auth.api.signInEmail({ body: { email: owner.email, password }, asResponse: true });
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; '); assert(cookie);
    const realSession = await authModule.auth.api.getSession({ headers: new Headers({ cookie }) }); assert(realSession); assert.equal(realSession.user.id, owner.id);
    const useOnly = await createAgent('use-only');
    await grants.upsertAgentGrant({ agentId: useOnly.agentId, organizationId: org, targetType: 'user', targetId: owner.id, actorUserId: 'manager', canUse: true, canEdit: false, canManage: false });
    assert.deepEqual(await access.getAgentAccess(owner.id, useOnly.agentId), { canUse: true, canEdit: false, canManage: false });
    const agentsRoute = await import('../app/api/agents/route'), grantRoute = await import('../app/api/agents/grants/route');
    const beforeApi = await snapshot(observer, useOnly.agentId);
    const request = (method: string, url: string, payload: unknown) => new NextRequest(url, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    for (const payload of [{ name: 'Denied owner profile' }, { relevantConnections: ['denied-owner-connection'] }, { enabledTools: ['read'] }]) {
      const response = await agentsRoute.PATCH(request('PATCH', 'http://localhost:3001/api/agents', { agentId: useOnly.agentId, expectedRevision: 1, ...payload }));
      assert.equal(response.status, 403); assert.equal((await response.json()).code, 'AGENT_ACCESS_DENIED');
    }
    for (const [method, handler] of [['PUT', grantRoute.PUT], ['DELETE', grantRoute.DELETE]] as const) {
      const response = await handler(request(method, 'http://localhost:3001/api/agents/grants', { agentId: useOnly.agentId, expectedRevision: 1, targetType: 'user', targetId: 'grant-target', canManage: true }));
      assert.equal(response.status, 403); assert.equal((await response.json()).code, 'AGENT_ACCESS_DENIED');
    }
    assert.deepEqual(await snapshot(observer, useOnly.agentId), beforeApi);
    const ownerWorkspace = await observer.get("SELECT id FROM canvas_workspaces WHERE owner_user_id=$1 AND type='personal' AND status='active' LIMIT 1", [owner.id]) as { id: string }; assert(ownerWorkspace);
    const mainAgent = await registry.ensureCanvasAgent();
    await runtime.db.insert((await import('../app/lib/db/schema')).piSessions).values({ sessionId: 'foundation-tool-session', userId: owner.id, agentId: mainAgent.agentId, workspaceId: ownerWorkspace.id, workspaceType: 'personal', organizationId: org, provider: 'fixture', model: 'fixture', createdAt: new Date(), updatedAt: new Date() });
    const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
    const context = await resolveAgentExecutionContextForStoredSession({ userId: owner.id, sessionId: 'foundation-tool-session', agentId: mainAgent.agentId });
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { createAgentManagementTools } = await import('../app/lib/pi/agent-management-tools');
    const tools = createAgentManagementTools(owner.id, mainAgent.agentId, 'foundation-tool-session');
    for (const [name, params] of [
      ['update_agent_profile', { name: 'Denied tool profile' }],
      ['update_agent_capabilities', { relevantConnections: ['denied-tool-connection'] }],
      ['update_agent_runtime', { enabledTools: ['read'] }],
      ['set_agent_grant', { targetType: 'user', targetId: 'grant-target', canManage: true }],
      ['remove_agent_grant', { targetType: 'user', targetId: 'grant-target' }],
    ] as const) {
      const tool = tools.find(entry => entry.name === name); assert(tool);
      await assert.rejects(() => runWithAgentExecutionContext(context, () => tool.execute('foundation-denied', { agentId: useOnly.agentId, expectedRevision: 1, ...params })), error => management.managementErrorDetails(error).status === 403);
    }
    assert.deepEqual(await snapshot(observer, useOnly.agentId), beforeApi);
    console.log('PASS actual native authority/API/AgentTool: canUse-only cannot configure; forged same-org team/project IDs denied; legitimate memberships, personal ownership and missing-context legacy behavior retained.');
    console.log('PASS foundation native PostgreSQL gate. Real production openDb/drizzle pool, actual SQL CAS/rollback and BetterAuth sessions; no mutation, ACL, auth-session or transport mocks.');
  } catch (error) {
    preserveData = isTransportFailure(error);
    throw error;
  } finally {
    if (locker) { try { await locker.run('ROLLBACK'); } catch (error) { if (!preserveData) throw error; } finally { await locker.close(); } }
    if (closeRuntime) await closeRuntime();
    loader._load = originalLoad;
    await observer.close();
    if (preserveData) {
      const pool = fixture.getPostgresRuntimeQueryable(); assert(pool instanceof Pool);
      await pool.end();
      console.error('External PostgreSQL transport interruption: preserved only this fixture database and DATA for inspection.', { database: identity.name, data: root });
    } else await fixture.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!preserveData) {
      assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), marker);
      assert.equal(path.dirname(root), os.tmpdir()); assert.match(path.basename(root), /^canvas-agent-foundation-native-/u);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error('Foundation native PostgreSQL gate failed.', {
    type: error instanceof Error ? error.name : 'Unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
    message: error instanceof Error ? error.message.replace(/https?:\/\/\S+|postgres(?:ql)?:\/\/\S+/gu, '[redacted-url]') : undefined,
  });
  process.exitCode = 1;
});
