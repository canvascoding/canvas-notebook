import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceAgentToolHistoricalOrigin, WorkspaceAgentToolPrincipalAccess,
  WorkspaceAgentMarkdownCreatePrincipal } from '../app/lib/workspaces/request-principal';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine PI captures and actual held PostgreSQL transactions. Only real SQL
// mutations and incompatible peer locks are used; no authority reply is mocked.
await withNativeCopyMetadataOwnerFixture(async h => {
  const principal = await import('../app/lib/workspaces/request-principal');
  const { readAgentProfileOnConnection } = await import('../app/lib/agents/registry');
  const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
  const { EMAIL_MANAGED_AGENT_ID } = await import('../app/lib/agents/storage');
  const { withPreparedDocumentCreateToolPolicy } = await import('../app/lib/public-sharing/tool-policy');
  const { openDb } = await import('../app/lib/db');
  const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
  const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
  const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
  const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
  const agentIds = [MAIN_AGENT_ID, EMAIL_MANAGED_AGENT_ID, 'policy-profile-special'];
  const contexts = new Map<string, Awaited<ReturnType<typeof resolveAgentExecutionContextForStoredSession>>>();
  for (const agentId of agentIds) {
    const special = agentId === 'policy-profile-special';
    await h.admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,
      owner_user_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'Policy profile','special',$2,$3,$4,'member','["write"]',100,200)
      ON CONFLICT(agent_id) DO UPDATE SET organization_id=excluded.organization_id,
        owner_user_id=excluded.owner_user_id,enabled_tools_json=excluded.enabled_tools_json`,
    [agentId, special ? 'restricted' : 'legacy', special ? 'organization' : 'system', special ? 'principal-org' : null]);
    if (special) await h.admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES($1,'principal-org','owner','active',1,100,100)`, [agentId]);
    await h.admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,'owner',$2,'fixture','fixture','principal-org',$3,$4,'Policy profile',$5,100,100)`,
    [`policy-profile-${agentId}`, agentId, h.source.workspaceId, h.source.workspaceType, h.source.rootRelativePath]);
    contexts.set(agentId, await resolveAgentExecutionContextForStoredSession({ sessionId: `policy-profile-${agentId}`,
      userId: 'owner', agentId, permissions: ['canRead', 'canRunAgent', 'canWrite'] }));
  }
  // Additional profile columns must never replace the actual context aliases.
  await h.admin.query(`ALTER TABLE agents ADD COLUMN __canvas_origin_schema text DEFAULT 'pg_catalog',
    ADD COLUMN __canvas_origin_organization_id text DEFAULT 'foreign-org',
    ADD COLUMN __canvas_policy_profile_present boolean DEFAULT false`);

  type Policy = { assertCurrent(database: SqlConnection, access: WorkspaceAgentToolPrincipalAccess): Promise<void> };
  type Body<T> = (database: SqlConnection, access: WorkspaceAgentToolPrincipalAccess,
    history: () => WorkspaceAgentToolHistoricalOrigin | undefined, policy?: Policy) => Promise<T>;
  async function phase<T>(agentId: string, body: Body<T>, options: { legacy?: boolean; policy?: boolean; observe?: () => void } = {}) {
    const context = contexts.get(agentId)!;
    return runWithAgentExecutionContext(context, () => withAgentToolInvocation(context,
      { toolName: 'write', toolCallId: `profile-${randomUUID()}` }, () => {
        const enter = (policy?: Policy) => {
          const execute = (p: WorkspaceAgentMarkdownCreatePrincipal,
            history: () => WorkspaceAgentToolHistoricalOrigin | undefined) => {
            assert.equal(history(), undefined, 'History is absent before a genuine phase has observed it.');
            return executeLifecycleTransaction({ openConnection: openDb, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              return principal.withWorkspaceAgentMarkdownCreatePrincipalOnConnection(database, p,
                access => body(database, access, history, policy));
            }, recoverCommitted: async () => { throw new Error('Unexpected unconfirmed policy-profile fixture.'); } });
          };
          if (!options.legacy) return principal.withWorkspaceAgentMarkdownCreatePrincipal({ workspaceId: h.source.workspaceId }, execute);
          let original: WorkspaceAgentToolHistoricalOrigin | undefined;
          return principal.withWorkspaceAgentMarkdownCreatePrincipalOriginalOrigin({ workspaceId: h.source.workspaceId },
            observed => { original = observed; options.observe?.(); }, p => execute(p, () => original));
        };
        return options.policy ? withPreparedDocumentCreateToolPolicy(enter) : enter();
      }));
  }
  const rows = async () => (await h.admin.query(`
    SELECT 'agent' AS kind,agent_id AS key,to_jsonb(a) AS value,xmin::text AS version FROM agents a
    UNION ALL SELECT 'account',id,to_jsonb(u),xmin::text FROM "user" u
    UNION ALL SELECT 'workspace',id,to_jsonb(w),xmin::text FROM canvas_workspaces w
    UNION ALL SELECT 'session',session_id,to_jsonb(s),xmin::text FROM pi_sessions s
    ORDER BY kind,key`)).rows;
  const code = (error: unknown) => error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  let groups = 0;

  for (const agentId of agentIds) {
    const before = await rows();
    let retained: (() => Promise<unknown>) | undefined;
    await phase(agentId, async (database, access, history) => {
      const reader = principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, access);
      assert(reader); retained = reader;
      assert.equal(principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, { ...access }), undefined);
      assert.equal(principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, new Proxy(access, {})), undefined);
      const expected = await readAgentProfileOnConnection(database, agentId), actual = await reader();
      assert.deepEqual(actual, expected); assert.equal(actual!.ownerUserId, 'member');
      assert.equal(actual!.organizationId, agentId === 'policy-profile-special' ? 'principal-org' : null);
      assert.equal(history()!.schema, h.schema); assert.equal(history()!.organizationId, 'principal-org');
      assert.equal(history()!.ownerUserId, h.source.ownerUserId); assert(Object.isFrozen(history()));
      await h.admin.query('BEGIN');
      try { await assert.rejects(h.admin.query('SELECT id FROM agents WHERE agent_id=$1 FOR UPDATE NOWAIT', [agentId]),
        error => code(error) === '55P03'); }
      finally { await h.admin.query('ROLLBACK'); }
    });
    await assert.rejects(retained!(), error => code(error) === 'PRINCIPAL_REQUIRED');
    await h.admin.query('BEGIN');
    try { assert.equal((await h.admin.query('SELECT id FROM agents WHERE agent_id=$1 FOR UPDATE NOWAIT', [agentId])).rowCount, 1); }
    finally { await h.admin.query('ROLLBACK'); }
    assert.deepEqual(await rows(), before); groups++;
  }

  // Actual Date objects from pg must behave exactly like the existing mapper.
  {
    const before = await rows();
    await phase(MAIN_AGENT_ID, async (database, access) => {
      await database.run('SAVEPOINT policy_profile_dates');
      try {
        await database.run(`ALTER TABLE agents ALTER COLUMN created_at TYPE timestamptz USING to_timestamp(created_at/1000.0),
          ALTER COLUMN updated_at TYPE timestamptz USING to_timestamp(updated_at/1000.0)`);
        const raw = await database.get('SELECT created_at FROM agents WHERE agent_id=$1', [MAIN_AGENT_ID]) as { created_at: unknown };
        assert(raw.created_at instanceof Date);
        const reader = principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, access); assert(reader);
        assert.deepEqual(await reader(), await readAgentProfileOnConnection(database, MAIN_AGENT_ID));
      } finally { await database.run('ROLLBACK TO SAVEPOINT policy_profile_dates'); await database.run('RELEASE SAVEPOINT policy_profile_dates'); }
    });
    assert.deepEqual(await rows(), before); groups++;
  }

  for (const fault of ['wrong-connection', 'reentrant', 'detached', 'account-ban'] as const) {
    const before = await rows(); let pending: Promise<unknown>[] = [], published = false;
    await assert.rejects(phase(MAIN_AGENT_ID, async (database, access) => {
      const reader = principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, access); assert(reader);
      if (fault === 'wrong-connection') {
        const wrong = principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(Object.create(database), access); assert(wrong);
        await assert.rejects(wrong(), error => code(error) === 'PRINCIPAL_REQUIRED');
      } else if (fault === 'reentrant') {
        pending = [reader(), reader()]; await Promise.allSettled(pending);
      } else if (fault === 'detached') {
        pending = [reader()]; void pending[0].catch(() => undefined);
      } else {
        await database.run('UPDATE "user" SET banned=1 WHERE id=$1', ['owner']);
        await assert.rejects(reader(), error => code(error) === 'PRINCIPAL_AUTH_REVOKED');
      }
      return 'swallowed failure';
    }).then(() => { published = true; }), error => code(error) === (fault === 'wrong-connection' ? 'PRINCIPAL_REQUIRED'
      : fault === 'reentrant' ? 'PRINCIPAL_REENTRANT' : fault === 'detached' ? 'PRINCIPAL_DETACHED' : 'PRINCIPAL_AUTH_REVOKED'));
    await Promise.allSettled(pending); assert.equal(published, false); assert.deepEqual(await rows(), before); groups++;
  }

  // Same-B drift after the genuine scope facts must fail at the retained final observation.
  for (const fault of ['search-path', 'workspace-root', 'profile-revision', 'relation-shadow'] as const) {
    const before = await rows(); let held: SqlConnection | undefined, armed = false, injected = false;
    await assert.rejects(h.withProbe(async event => {
      const row: unknown = Array.isArray(event.result.rows) ? event.result.rows[0] : undefined;
      if (!armed || !row || typeof row !== 'object' || !Array.isArray(Reflect.get(row, 'sessions'))
        || !Object.hasOwn(row, 'workspace') || !Object.hasOwn(row, 'seat')) return;
      armed = false; injected = true; assert(held);
      if (fault === 'search-path') await held.run('SET LOCAL search_path=pg_catalog');
      else if (fault === 'workspace-root') await held.run("UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'/drift' WHERE id=$1", [h.source.workspaceId]);
      else if (fault === 'profile-revision') await held.run('UPDATE agents SET revision=revision+1 WHERE agent_id=$1', [MAIN_AGENT_ID]);
      else { await held.run('ALTER TABLE agent_members RENAME TO policy_profile_original_members'); await held.run('CREATE TEMP TABLE agent_members (not_a_member integer)'); }
    }, () => phase(MAIN_AGENT_ID, async (database, access) => {
      held = database; const reader = principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, access); assert(reader);
      armed = true; await reader(); return 'must not publish';
    })), error => code(error) === (fault === 'relation-shadow' ? 'PRINCIPAL_SCHEMA_INVALID' : 'PRINCIPAL_SCOPE_CHANGED'));
    assert(injected); assert.deepEqual(await rows(), before); groups++;
  }

  for (const mutateProfile of [false, true]) {
    const before = await rows(); let held: SqlConnection | undefined, armed = false, joined = 0, standalone = 0;
    const run = () => h.withProbe(async event => {
      if (!armed) return;
      if (/^\s*SELECT\s+\*\s+FROM\s+agents\b/iu.test(event.text)) standalone++;
      if (!event.text.includes('AS __canvas_policy_profile_present')) return;
      joined++;
      if (mutateProfile && joined === 1) { assert(held); await held.run("UPDATE agents SET default_model='changed-during-policy' WHERE agent_id=$1", [MAIN_AGENT_ID]); }
    }, () => phase(MAIN_AGENT_ID, async (database, access, _history, policy) => {
      held = database; assert(policy); armed = true;
      try {
        if (mutateProfile) {
          await assert.rejects(policy.assertCurrent(database, access), error => code(error) === 'TOOL_POLICY_CHANGED');
          await policy.assertCurrent(database, access); // A caught policy failure remains poisoned.
        } else await policy.assertCurrent(database, access);
      } finally { armed = false; }
      return 'policy verified';
    }, { policy: true }));
    if (mutateProfile) await assert.rejects(run(), error => code(error) === 'TOOL_POLICY_CHANGED');
    else assert.equal(await run(), 'policy verified');
    assert.equal(joined, 2, 'Both actual before/after observations remain fresh.');
    assert.equal(standalone, 0, 'The genuine Create policy no longer repeats standalone profile queries.');
    assert.deepEqual(await rows(), before); groups++;
  }

  let legacyObservations = 0;
  await phase(MAIN_AGENT_ID, async (database, access) => {
    assert.equal(principal.getWorkspaceAgentMarkdownCreatePolicyProfileReader(database, access), undefined);
    await access.assertCurrent();
  }, { legacy: true, observe: () => { legacyObservations++; } });
  assert.equal(legacyObservations, 3, 'The existing external observer API retains initial, explicit and final callbacks.');
  groups++;
  assert.equal(groups, 15);
  console.log(JSON.stringify({ suite: 'agent-markdown-create-policy-profile', groups,
    evidence: 'genuine_profile_parity_raw_dates_distinct_origin_columns_peer_locks_current_drift_provenance_poison_detached_and_legacy_observers' }));
});
