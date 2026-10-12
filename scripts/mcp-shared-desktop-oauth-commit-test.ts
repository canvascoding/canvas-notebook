import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { AuthorizedIntegrationConnection, IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import type { SharedMcpDesktopOAuthSnapshot } from '../app/lib/mcp/shared-desktop-oauth-contract';

const expectCode = (code: string) => (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === code;

/** Real PostgreSQL schema and CommonStore authority; only the DB module transport is substituted. */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-shared-desktop-ledger-'));
  const rootIdentity = await fs.lstat(root);
  const env = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/unused_isolated_fixture',
    CANVAS_INSTANCE_ID: 'shared-desktop-ledger-fixture', CANVAS_ORGANIZATION_ID: 'ledger-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    BASE_URL: 'http://127.0.0.1:3001', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3001', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const database = await createPiTestDatabase();
  let leases = 0;
  const dbTransport = { ...database, openDb: async () => { leases += 1; return database.openDb(); } };
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return dbTransport;
    return original(name, parent, isMain);
  };
  const raw = await database.openDb();
  try {
    for (const id of ['owner', 'manager', 'reader']) {
      await raw.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'user\',0,1,1000,1000)', [id, `${id}@ledger.example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('ledger-org','owner','team',1,1000,1000)");
    for (const id of ['owner', 'manager', 'reader']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('ledger-org',$1,$2,'active',0,1000,1000)", [id, id === 'owner' ? 'owner' : 'member']);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'ledger-org','personal',$2,$3,$2,'active',1000,1000)", [`ws-${id}`, id, `workspaces/${id}/files`]);
    }
    await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('ledger-team','ledger-org','team','workspaces/team/files','Ledger team','active',1000,1000)");
    const store = await import('../app/lib/integration-tools/connections/store');
    const contract = await import('../app/lib/mcp/shared-desktop-oauth-contract');
    const ledger = await import('../app/lib/mcp/desktop-oauth-commit');
    const owner = { userId: 'owner', workspaceId: 'ws-owner' }, manager = { userId: 'manager', workspaceId: 'ws-manager' };
    const created: IntegrationConnectionRecord[] = [];
    for (const ownership of [{ type: 'organization' as const, organizationId: 'ledger-org' }, { type: 'team' as const, organizationId: 'ledger-org', workspaceId: 'ledger-team' }]) {
      created.push(await store.createSharedIntegrationConnection(owner, { ownership, displayName: `Ledger ${ownership.type}`, backend: { source: 'mcp', connectionId: randomUUID() },
        grants: [{ targetType: 'user', targetId: 'manager', canManage: true, canUse: false, allowedToolNames: null }] }));
    }
    const revisions = (record: IntegrationConnectionRecord) => ({ metadataRevision: record.resource.metadataRevision, grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision });
    const snapshot = (authorization: AuthorizedIntegrationConnection): SharedMcpDesktopOAuthSnapshot => {
      assert.equal(authorization.backend.source, 'mcp');
      if (authorization.backend.source !== 'mcp') throw new Error('Expected MCP fixture binding.');
      return contract.parseSharedMcpDesktopOAuthSnapshot({ connectionId: authorization.backend.connectionId, organizationId: 'ledger-org',
        authVersion: 3, configHash: createHash('sha256').update('fixture-config').digest('hex'), lifecycleGeneration: 4, serverUrl: 'https://ledger.example.test/mcp',
        shared: { connectionRef: authorization.resource.connectionRef, ownership: authorization.resource.ownership, initiatingUserId: manager.userId,
          revisions: revisions(authorization), authorizationRevision: authorization.authorizationRevision },
        sharedDesktopInitiator: { actor: authorization.actor, authSessionId: 'actual-captured-session-fixture' } });
    };
    const orgAuth = await store.authorizeIntegrationConnection(manager, created[0].resource.connectionRef, 'manage');
    assert.equal(orgAuth.access.canManage, true); assert.equal(orgAuth.access.canUse, false, 'Manage-only authority needs no provider-use seat fixture.');
    const parsed = snapshot(orgAuth);
    assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.shared) && Object.isFrozen(parsed.shared.revisions)
      && Object.isFrozen(parsed.sharedDesktopInitiator.actor), 'The exact snapshot is copied and deeply frozen.');
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    assert.equal(contract.sharedMcpDesktopSnapshotFingerprint(parsed), contract.sharedMcpDesktopSnapshotFingerprint(contract.parseSharedMcpDesktopOAuthSnapshot(reversed)));
    assert.equal(contract.sharedMcpDesktopActorFingerprint({ ...manager }), contract.sharedMcpDesktopActorFingerprint({ ...manager, organizationId: null, agentId: null, sessionId: null }));
    for (const invalid of [{ ...parsed, codeVerifier: 'forged-secret' }, { ...parsed, shared: undefined },
      { ...parsed, sharedDesktopInitiator: { ...parsed.sharedDesktopInitiator, authSessionId: '' } },
      { ...parsed, organizationId: 'wrong-org' }, { ...parsed, shared: { ...parsed.shared, initiatingUserId: 'reader' } },
      ...['agentId', 'sessionId', 'policyRevision'].map(field => ({ ...parsed, sharedDesktopInitiator: { ...parsed.sharedDesktopInitiator,
        actor: { ...manager, [field]: 'forged-pi-identity' } } }))]) {
      assert.throws(() => contract.parseSharedMcpDesktopOAuthSnapshot(invalid), expectCode('CONNECTION_DESKTOP_OAUTH_SNAPSHOT_INVALID'));
    }
    const copied = structuredClone(parsed), captured = contract.parseSharedMcpDesktopOAuthSnapshot(copied);
    copied.shared.revisions.bindingRevision += 1;
    assert.equal(captured.shared.revisions.bindingRevision, parsed.shared.revisions.bindingRevision, 'Parsing never retains mutable caller input.');
    assert.notEqual(contract.sharedMcpDesktopSessionFingerprint('session-one'), contract.sharedMcpDesktopSessionFingerprint('session-two'));
    console.log('PASS strict shared desktop snapshots: human identity, ordered fingerprints, independent owner and copied immutable bindings.');

    const committedStates: string[] = [];
    for (const resource of created) {
      const state = `desktop_${randomBytes(24).toString('base64url')}`; committedStates.push(state);
      await store.withAuthorizedIntegrationConnection(manager, resource.resource.connectionRef, 'manage', revisions(resource), async (before, sql) => {
        const flow = snapshot(before), opened = leases;
        await store.publishIntegrationConnectionBinding(manager, resource.resource.connectionRef, revisions(before), before.backend);
        const after = await store.authorizeIntegrationConnection(manager, resource.resource.connectionRef, 'manage');
        const input = { state, snapshot: flow, authorizationBefore: before, authorizationAfter: after };
        const receipt = await ledger.recordSharedMcpDesktopOAuthCommit(sql, input);
        assert.deepEqual(await ledger.recordSharedMcpDesktopOAuthCommit(sql, input), receipt, 'Same-flow retries preserve the original receipt and timestamp.');
        assert.equal(leases, opened, 'Publication, post-authorization and ledger borrow no nested SQL lease.');
        assert.equal(receipt.publishedBindingRevision, before.resource.bindingRevision + 1);
        assert.equal(receipt.snapshotHash, contract.sharedMcpDesktopSnapshotFingerprint(flow));
        assert.equal(receipt.authSessionHash, contract.sharedMcpDesktopSessionFingerprint(flow.sharedDesktopInitiator.authSessionId));
        await assert.rejects(ledger.recordSharedMcpDesktopOAuthCommit(sql, { ...input, authorizationBefore: structuredClone(before) }), expectCode('CONNECTION_ACCESS_DENIED'));
        await assert.rejects(ledger.recordSharedMcpDesktopOAuthCommit(sql, { ...input, authorizationAfter: before }), expectCode('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID'));
        await assert.rejects(ledger.recordSharedMcpDesktopOAuthCommit(sql, { ...input, snapshot: { ...flow,
          sharedDesktopInitiator: { ...flow.sharedDesktopInitiator, authSessionId: 'different-auth-session' } } }), expectCode('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID'));
        assert.deepEqual(await ledger.readSharedMcpDesktopOAuthCommit(sql, state), receipt);
      });
    }
    assert.equal((await raw.all('SELECT * FROM mcp_shared_desktop_oauth_commits')).length, 2);
    const rows = await raw.all('SELECT * FROM mcp_shared_desktop_oauth_commits');
    assert.doesNotMatch(JSON.stringify(rows), /desktop_|actual-captured-session-fixture|codeVerifier|accessToken|clientSecret|ledger\.example/u,
      'SQL commit evidence contains only bound hashes/revisions/identities, no raw state, auth-session or provider credentials.');
    const firstReceipt = await ledger.readSharedMcpDesktopOAuthCommit(raw, committedStates[0]);
    await runPostgresMigrations(database.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
    assert.deepEqual(await ledger.readSharedMcpDesktopOAuthCommit(raw, committedStates[0]), firstReceipt, 'Actual repeated startup migrations preserve commit evidence.');
    console.log('PASS actual common authority + organization/team SQL publication: same-flow idempotence, private receipt and migration preservation.');

    const ref = created[0].resource.connectionRef, beforeRollback = (await store.getIntegrationConnectionRecord(ref))!;
    const rolledBackState = `desktop_${randomBytes(24).toString('base64url')}`;
    await assert.rejects(store.withAuthorizedIntegrationConnection(manager, ref, 'manage', revisions(beforeRollback), async (before, sql) => {
      const flow = snapshot(before);
      await store.publishIntegrationConnectionBinding(manager, ref, revisions(before), before.backend);
      const after = await store.authorizeIntegrationConnection(manager, ref, 'manage');
      await ledger.recordSharedMcpDesktopOAuthCommit(sql, { state: rolledBackState, snapshot: flow, authorizationBefore: before, authorizationAfter: after });
      throw new Error('fixture-failure-after-receipt');
    }), /fixture-failure-after-receipt/u);
    assert.equal(await ledger.readSharedMcpDesktopOAuthCommit(raw, rolledBackState), null);
    assert.deepEqual(await store.getIntegrationConnectionRecord(ref), beforeRollback, 'Binding and same-flow receipt roll back together.');
    await store.publishIntegrationConnectionBinding(manager, ref, revisions(beforeRollback), beforeRollback.backend);
    assert.equal((await store.getIntegrationConnectionRecord(ref))!.resource.bindingRevision, beforeRollback.resource.bindingRevision + 1);
    assert.equal(await ledger.readSharedMcpDesktopOAuthCommit(raw, rolledBackState), null, 'An unrelated same-backend bind/history cannot manufacture completion for the rolled-back flow.');
    await assert.rejects(store.withAuthorizedIntegrationConnection({ userId: 'reader', workspaceId: 'ws-reader' }, ref, 'manage', undefined,
      async () => { throw new Error('Unauthorized callback entered.'); }), expectCode('CONNECTION_ACCESS_DENIED'));
    assert.equal((await raw.all('SELECT * FROM mcp_shared_desktop_oauth_commits')).length, 2);
    console.log('PASS atomic rollback and exact-flow evidence: unrelated later binding cannot recover an uncommitted desktop flow.');

    await raw.run('BEGIN');
    try {
      await raw.run('UPDATE mcp_shared_desktop_oauth_commits SET post_authorization_revision=$1 WHERE state_hash=$2', ['malformed', firstReceipt!.stateHash]);
      await assert.rejects(ledger.readSharedMcpDesktopOAuthCommit(raw, committedStates[0]), expectCode('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID'));
    } finally { await raw.run('ROLLBACK'); }
    await assert.rejects(raw.run('UPDATE mcp_shared_desktop_oauth_commits SET published_binding_revision=pre_binding_revision WHERE state_hash=$1', [firstReceipt!.stateHash]), /mcp_shared_desktop_commits_revisions_check/u);
    await assert.rejects(raw.run('UPDATE mcp_shared_desktop_oauth_commits SET connection_ref=$1 WHERE state_hash=$2', [`canvas-connection:${randomUUID()}`, firstReceipt!.stateHash]), /foreign key/u);
    await assert.rejects(ledger.readSharedMcpDesktopOAuthCommit(raw, 'desktop_bad'), expectCode('CONNECTION_DESKTOP_OAUTH_COMMIT_INVALID'));
    assert.deepEqual(await ledger.readSharedMcpDesktopOAuthCommit(raw, committedStates[0]), firstReceipt);
    console.log('PASS fail-closed ledger reads, actual FK/revision constraints and no unauthorized publication.');
  } finally {
    loader._load = original;
    await raw.close(); await database.close();
    const currentIdentity = await fs.lstat(root);
    if (!currentIdentity.isDirectory() || currentIdentity.isSymbolicLink() || currentIdentity.dev !== rootIdentity.dev || currentIdentity.ino !== rootIdentity.ino) {
      throw new Error('Own fixture DATA identity changed; preserving it.');
    }
    await fs.rm(root, { recursive: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
