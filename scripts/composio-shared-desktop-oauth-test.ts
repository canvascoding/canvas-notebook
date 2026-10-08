import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import { createComposioProviderFixture } from './helpers/composio-provider-fixture';
import { createActualManagedProxy } from './helpers/actual-managed-composio-fixture';

type DesktopSummary = { connectionRef: string; state: string; status: 'starting' | 'waiting' | 'callback_received'
  | 'completed' | 'cancelled' | 'expired' | 'failed'; expiresAt: string; authorizationUrl?: string; code?: string; error?: string };
type Initiator = { actor: { userId: string; workspaceId: string }; authSessionId: string };
type OwnDatabase = Awaited<ReturnType<typeof createSharedConnectionTestDatabase>>;

function expectSharedComposioDesktopCode(code?: string) {
  return (error: unknown) => error instanceof Error && (!code || (error as Error & { code?: string }).code === code);
}

function intentForSharedComposioDesktopCase() { return randomBytes(32).toString('base64url'); }

function assertSharedComposioDesktopSummary(value: unknown, record: IntegrationConnectionRecord): asserts value is DesktopSummary {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const summary = value as DesktopSummary;
  assert.equal(summary.connectionRef, record.resource.connectionRef);
  assert.match(summary.state, /^[A-Za-z0-9_-]{43}$/u);
  assert(Number.isFinite(Date.parse(summary.expiresAt)));
  assert(['starting', 'waiting', 'callback_received', 'completed', 'cancelled', 'expired', 'failed'].includes(summary.status));
  const negative = ['starting', 'cancelled', 'expired', 'failed'].includes(summary.status);
  assert.deepEqual(Object.keys(summary).sort(), ['connectionRef', 'state', 'status', 'expiresAt',
    ...(summary.status === 'waiting' ? ['authorizationUrl'] : []), ...(negative ? ['code', 'error'] : [])].sort());
  if (summary.status === 'waiting') assert.equal(new URL(summary.authorizationUrl!).protocol, 'https:');
  else assert.equal(Object.hasOwn(summary, 'authorizationUrl'), false);
  if (negative) {
    assert(typeof summary.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(summary.code));
    assert(typeof summary.error === 'string' && summary.error.length > 0 && summary.error.length <= 240);
    assert.doesNotMatch(summary.error, /https?:|authSession|connectedAccount|composioUser|profileId/u);
  }
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /authSessionId|credentialRevision|pendingAccountId|initiatingUserId|actor_context|baseline_sealed/u);
  if (record.backend.source === 'composio') assert.equal(serialized.includes(record.backend.profileId), false);
}

async function snapshotSharedComposioDesktopRows(sql: SqlConnection, ref: string) {
  // Keep full private row comparison in RAM; the top-level failure logger never prints assertion values.
  return { transactions: await sql.all('SELECT to_jsonb(row) AS value FROM composio_shared_desktop_oauth_transactions row WHERE connection_ref=$1 ORDER BY to_jsonb(row)::text', [ref]),
    commits: await sql.all('SELECT to_jsonb(row) AS value FROM composio_shared_desktop_oauth_commits row WHERE connection_ref=$1 ORDER BY to_jsonb(row)::text', [ref]) };
}

async function createSharedComposioDesktopFixture() {
  assert(process.argv.slice(2).every(argument => argument === '--managed'));
  assert(process.argv.slice(2).length <= 1);
  const managedMode = process.argv.includes('--managed');
  if (managedMode) assert(process.env.CANVAS_CONTROL_PLANE_TEST_ROOT);
  assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1', 'This gate requires an acknowledged own native PostgreSQL database.');
  assert.equal(process.env.NODE_ENV, 'test');
  const maintenance = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol));
  assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433');
  assert.equal(maintenance.search, ''); assert.equal(maintenance.hash, '');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-desktop-engine-')));
  await fs.chmod(root, 0o700); const rootIdentity = await fs.lstat(root), marker = randomUUID();
  const dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp');
  await fs.mkdir(dataRoot, { mode: 0o700 }); await fs.mkdir(tmpRoot, { mode: 0o700 });
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
  const environment = { DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, TMPDIR: tmpRoot,
    CANVAS_INSTANCE_ID: managedMode ? 'composio-runtime' : `composio-desktop-${marker}`, CANVAS_ORGANIZATION_ID: 'desktop-composio-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: managedMode ? 'true' : 'false',
    CANVAS_CONTROL_PLANE_URL: '', CANVAS_INSTANCE_TOKEN: managedMode ? 'fixture-instance-token' : '',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), AUTH_SECRET: randomBytes(48).toString('base64url'),
    BASE_URL: 'http://127.0.0.1:3001', COMPOSIO_API_KEY: '', COMPOSIO_BASE_URL: '' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let database: OwnDatabase | undefined, provider: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let managed: Awaited<ReturnType<typeof createActualManagedProxy>> | undefined, managedKey = 'own-managed-composio-key';
  let databaseName: string | undefined;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  let leases = 0, leasePeak = 0, leaseAcquisitions = 0, poolClosed = false, providerClosed = false;
  let losePublicationAcknowledgment = false, publicationAcknowledgmentsLost = 0;
  const close = async () => {
    loader._load = originalLoad;
    if (managed) { await managed.close(); mock.restoreAll(); }
    if (provider) { await provider.close(); providerClosed = true; }
    assert.equal(leases, 0, 'Every own SQL lease must close before normal DROP.');
    if (database) { await database.close(); poolClosed = true; }
    const actual = await fs.lstat(root);
    assert(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === rootIdentity.dev && actual.ino === rootIdentity.ino);
    assert.equal(actual.uid, process.getuid?.()); assert.equal(actual.mode & 0o777, 0o700);
    assert.equal(await fs.realpath(root), root); assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), marker);
    assert(!database || poolClosed); assert(!provider || providerClosed);
    await fs.rm(root, { recursive: true, force: false });
    if (databaseName) console.log(`NATIVE_RECEIPT ${JSON.stringify({ phase: 'cleaned', databaseName, root })}`);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  try {
    database = await createSharedConnectionTestDatabase(); assert.equal(database.native, true);
    provider = await createComposioProviderFixture(); process.env.COMPOSIO_BASE_URL = provider.baseUrl;
    // Managed mode uses real CP routes/SDK, with the unchanged helper's explicit CP authority doubles.
    // It does not claim native CP authentication, license issuance or production provider acceptance.
    if (managedMode) { managed = await createActualManagedProxy(() => managedKey); process.env.CANVAS_CONTROL_PLANE_URL = managed.baseUrl; }
    const actualDatabase = database;
    const transport = { ...actualDatabase, openDb: async (): Promise<SqlConnection> => {
      const actual = await actualDatabase.openDb(); leases += 1; leaseAcquisitions += 1; leasePeak = Math.max(leasePeak, leases);
      let closed = false, publicationInserted = false;
      return { get: actual.get, all: actual.all, run: async (query, parameters = []) => {
        const result = await actual.run(query, parameters);
        if (/^INSERT INTO composio_shared_desktop_oauth_commits\b/u.test(query.trim())) publicationInserted = true;
        if (query.trim() === 'COMMIT' && publicationInserted && losePublicationAcknowledgment) {
          // The real PostgreSQL COMMIT has returned successfully. Only this adapter's ACK is lost.
          losePublicationAcknowledgment = false; publicationAcknowledgmentsLost += 1;
          throw new Error('OWN_PUBLICATION_COMMIT_ACK_LOST');
        }
        return result;
      }, close: async () => {
        if (!closed) { closed = true; await actual.close(); leases -= 1; }
      } };
    } };
    loader._load = (name, parent, isMain) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return transport;
      return originalLoad(name, parent, isMain);
    };
    const sql = await transport.openDb();
    try {
      databaseName = (await sql.get('SELECT current_database() AS name') as { name: string }).name;
      assert.match(databaseName, /^canvas_connection_test_[a-f0-9]{32}$/u);
      console.log(`NATIVE_RECEIPT ${JSON.stringify({ phase: 'created', databaseName, root })}`);
      for (const id of ['desktop-owner', 'desktop-manager', 'desktop-other']) {
        await sql.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,$3,0,1,1000,1000)',
          [id, `${id}@own-composio.example.test`, id === 'desktop-owner' ? 'admin' : 'user']);
        await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)',
          [`session-${id}`, id, randomUUID(), Date.now() + 2 * 60 * 60_000]);
      }
      await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)',
        ['session-manager-new', 'desktop-manager', randomUUID(), Date.now() + 2 * 60 * 60_000]);
      await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('desktop-composio-org','desktop-owner','team',1,1000,1000)");
      for (const id of ['desktop-owner', 'desktop-manager', 'desktop-other']) {
        await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('desktop-composio-org',$1,$2,'active',0,1000,1000)",
          [id, id === 'desktop-owner' ? 'owner' : 'member']);
        await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'desktop-composio-org','personal',$2,$3,$2,'active',1000,1000)",
          [`ws-${id}`, id, `workspaces/${id}/files`]);
      }
      await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('desktop-composio-team','desktop-composio-org','team','workspaces/own-team/files','Own desktop team','active',1000,1000)");
      for (const id of ['desktop-owner', 'desktop-manager']) await sql.run("INSERT INTO canvas_workspace_members (organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES ('desktop-composio-org','desktop-composio-team',$1,'member','active',1,0,1000,1000)", [id]);
      return { root, dataRoot, provider, sql, close, managedMode, managedOrigin: managed?.baseUrl,
        repeatMigrations: async () => {
          assert.equal(actualDatabase.native, true);
          assert.equal((await sql.get('SELECT current_database() AS name') as { name: string }).name, databaseName);
          await runPostgresMigrations(actualDatabase.getPostgresRuntimeQueryable() as unknown as Parameters<typeof runPostgresMigrations>[0]);
        },
        rotateManagedKey: (rotated: boolean) => { managedKey = rotated ? 'own-managed-composio-key-rotated' : 'own-managed-composio-key'; },
        resetLeaseDiagnostics: () => { assert.equal(leases, 1); leasePeak = 1; leaseAcquisitions = 0; },
        leaseDiagnostics: () => ({ active: leases, peak: leasePeak, acquired: leaseAcquisitions }),
        loseNextPublicationCommitAcknowledgment: () => { assert.equal(losePublicationAcknowledgment, false); losePublicationAcknowledgment = true; },
        publicationAcknowledgmentsLost: () => publicationAcknowledgmentsLost };
    } catch (error) { await sql.close(); throw error; }
  } catch (error) { await close(); throw error; }
}

async function main() {
  const fixture = await createSharedComposioDesktopFixture();
  try {
    const { sql, provider } = fixture;
    const actualDesktop = await import('../app/lib/composio/composio-shared-desktop-oauth');
    const observeSharedComposioDesktopOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
      fixture.resetLeaseDiagnostics();
      try { return await operation(); }
      finally {
        const diagnostics = fixture.leaseDiagnostics();
        assert.equal(diagnostics.active, 1, 'Engine operations must release every own lease.');
        assert(diagnostics.peak <= 2, 'The Engine must reuse the held SQL connection, not acquire a nested pool lease.');
      }
    };
    const desktop = {
      startSharedComposioDesktopOAuth: (...args: Parameters<typeof actualDesktop.startSharedComposioDesktopOAuth>) => observeSharedComposioDesktopOperation(() => actualDesktop.startSharedComposioDesktopOAuth(...args)),
      getSharedComposioDesktopOAuthStatus: (...args: Parameters<typeof actualDesktop.getSharedComposioDesktopOAuthStatus>) => observeSharedComposioDesktopOperation(() => actualDesktop.getSharedComposioDesktopOAuthStatus(...args)),
      finalizeSharedComposioDesktopOAuth: (...args: Parameters<typeof actualDesktop.finalizeSharedComposioDesktopOAuth>) => observeSharedComposioDesktopOperation(() => actualDesktop.finalizeSharedComposioDesktopOAuth(...args)),
      cancelSharedComposioDesktopOAuth: (...args: Parameters<typeof actualDesktop.cancelSharedComposioDesktopOAuth>) => observeSharedComposioDesktopOperation(() => actualDesktop.cancelSharedComposioDesktopOAuth(...args)),
      collectSharedComposioDesktopOAuthCallback: (...args: Parameters<typeof actualDesktop.collectSharedComposioDesktopOAuthCallback>) => observeSharedComposioDesktopOperation(() => actualDesktop.collectSharedComposioDesktopOAuthCallback(...args)),
    };
    const profiles = await import('../app/lib/composio/composio-shared-profiles');
    const backend = await import('../app/lib/composio/composio-shared-backend');
    const store = await import('../app/lib/integration-tools/connections/store');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const owner = { userId: 'desktop-owner', workspaceId: 'ws-desktop-owner' };
    const manager: Initiator = { actor: { userId: 'desktop-manager', workspaceId: 'ws-desktop-manager' }, authSessionId: 'session-desktop-manager' };
    const orgOwnership = { type: 'organization' as const, organizationId: 'desktop-composio-org' };
    const teamOwnership = { type: 'team' as const, organizationId: 'desktop-composio-org', workspaceId: 'desktop-composio-team' };
    const secretScope = { secretScope: 'organization' as const, organizationId: orgOwnership.organizationId };
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-org-composio-key' }], secretScope);
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-personal-decoy-key' }], { secretScope: 'user', userId: manager.actor.userId });
    await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-system-decoy-key' }], { secretScope: 'legacy' });
    const providerMode = fixture.managedMode ? 'managed' as const : 'local' as const;
    const orgProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: orgOwnership, name: 'Own organization designs', providerMode });
    const teamProfile = await profiles.createSharedComposioProfile({ actor: owner, ownership: teamOwnership, name: 'Own team designs', providerMode });
    assert.notEqual(orgProfile.id, teamProfile.id); assert.notEqual(orgProfile.composioUserId, teamProfile.composioUserId);
    for (const profile of [orgProfile, teamProfile]) provider.accounts.set(profile.composioUserId, [
      { id: `${profile.id}-active-first`, toolkit: 'canva', status: 'ACTIVE' },
      { id: `${profile.id}-active-second`, toolkit: 'canva', status: 'ACTIVE' },
      { id: `${profile.id}-other-toolkit`, toolkit: 'slack', status: 'ACTIVE' },
    ]);
    const grants = [{ targetType: 'user' as const, targetId: manager.actor.userId, canUse: false, canManage: true, allowedToolNames: [] }];
    const current = async (ref: string) => { const value = await store.getIntegrationConnectionRecord(ref); assert(value); return value; };
    const create = async (team = false, toolkit = 'canva') => store.createSharedIntegrationConnection(owner, {
      ownership: team ? teamOwnership : orgOwnership, displayName: `Own desktop ${randomUUID()}`, accessMode: 'restricted', allowedToolNames: [], grants,
      backend: await backend.prepareSharedComposioConnectionBackend(owner, { ownership: team ? teamOwnership : orgOwnership,
        profileId: team ? teamProfile.id : orgProfile.id, toolkit }),
    });
    const revisions = (record: IntegrationConnectionRecord) => ({ metadataRevision: record.resource.metadataRevision,
      grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision });
    const start = async (record: IntegrationConnectionRecord, initiator = manager, intent = intentForSharedComposioDesktopCase()) => {
      const result = await desktop.startSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, { ...revisions(record), intent });
      assertSharedComposioDesktopSummary(result, record); assert.equal(result.status, 'waiting'); return { ...result, intent };
    };
    const links = () => provider.calls.filter(call => /\/tool_router\/session\/[^/]+\/link$/u.test(call.path)).length;
    const activateAndCollect = async (record: IntegrationConnectionRecord, flow: DesktopSummary) => {
      assert.equal(record.backend.source, 'composio');
      const profile = record.resource.ownership.type === 'team' ? teamProfile : orgProfile;
      const pending = provider.accounts.get(profile.composioUserId)!.filter(account => account.status === 'INITIATED').at(-1); assert(pending);
      let callbackHref = provider.completeOAuth(pending.id)!;
      if (fixture.managedMode) {
        assert.equal(new URL(callbackHref).origin, fixture.managedOrigin);
        const broker = await fetch(callbackHref, { redirect: 'manual' }); assert.equal(broker.status, 302);
        callbackHref = broker.headers.get('location')!; await broker.body?.cancel();
      }
      const callback = new URL(callbackHref);
      assert.equal(callback.origin, 'http://127.0.0.1:3001'); assert.equal(callback.pathname, '/api/composio/shared/desktop/callback');
      assert.equal(callback.searchParams.get('flow'), flow.state); assert.deepEqual([...callback.searchParams.keys()], ['flow']);
      const beforeCalls = provider.calls.length, beforeRecord = await current(record.resource.connectionRef);
      await desktop.collectSharedComposioDesktopOAuthCallback(flow.state);
      assert.equal(provider.calls.length, beforeCalls, 'The public collector performs zero SDK requests.');
      assert.deepEqual(await current(record.resource.connectionRef), beforeRecord, 'Collection cannot publish a binding.');
      return pending.id;
    };

    for (const team of [false, true]) {
      const record = await create(team), initiator = team ? { ...manager, actor: { ...manager.actor, workspaceId: teamOwnership.workspaceId } } : manager;
      const beforeGrants = await sql.all('SELECT * FROM integration_connection_grants WHERE connection_ref=$1 ORDER BY id', [record.resource.connectionRef]);
      const access = await store.authorizeIntegrationConnection(initiator.actor, record.resource.connectionRef, 'manage');
      assert.equal(access.access.canManage, true); assert.equal(access.access.canUse, false);
      let preparedIntentObserved = false;
      provider.rotateOnEndpoint('/api/v3.1/tool_router/session', async () => {
        const rows = await snapshotSharedComposioDesktopRows(sql, record.resource.connectionRef);
        assert.equal(rows.transactions.length, 1); assert.equal(rows.commits.length, 0);
        assert.equal((rows.transactions[0] as { value: { status: string } }).value.status, 'starting');
        preparedIntentObserved = true;
      });
      const flow = await start(record, initiator), beforeReplay = provider.calls.length;
      assert.equal(preparedIntentObserved, true, 'The starting intent must be committed before the real SDK creates its provider session.');
      const replayStart = await desktop.startSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, { ...revisions(record), intent: flow.intent });
      assertSharedComposioDesktopSummary(replayStart, record); assert.equal(replayStart.state, flow.state); assert.equal(provider.calls.length, beforeReplay);
      const selectedAccount = await activateAndCollect(record, flow);
      const collected = await desktop.getSharedComposioDesktopOAuthStatus(initiator, record.resource.connectionRef, flow.state);
      assertSharedComposioDesktopSummary(collected, record); assert.equal(collected.status, 'callback_received');
      const completed = await desktop.finalizeSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, flow.state);
      assertSharedComposioDesktopSummary(completed, record); assert.equal(completed.status, 'completed');
      const published = await current(record.resource.connectionRef);
      assert.equal(published.resource.bindingRevision, record.resource.bindingRevision + 1);
      assert.equal(published.resource.metadataRevision, record.resource.metadataRevision); assert.equal(published.resource.grantsRevision, record.resource.grantsRevision);
      assert.deepEqual(await sql.all('SELECT * FROM integration_connection_grants WHERE connection_ref=$1 ORDER BY id', [record.resource.connectionRef]), beforeGrants);
      assert.equal(published.backend.source, 'composio');
      if (published.backend.source === 'composio') assert.equal(published.backend.connectedAccountId, selectedAccount);
      const committed = await snapshotSharedComposioDesktopRows(sql, record.resource.connectionRef); assert.equal(committed.commits.length, 1);
      const beforeLinks = links();
      assert.equal((await desktop.finalizeSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, flow.state)).status, 'completed');
      assert.equal((await desktop.startSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, { ...revisions(record), intent: flow.intent }) as DesktopSummary).state, flow.state);
      assert.equal(links(), beforeLinks); assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, record.resource.connectionRef), committed);
      await assert.rejects(desktop.startSharedComposioDesktopOAuth(initiator, record.resource.connectionRef, { ...revisions(published), intent: flow.intent }), expectSharedComposioDesktopCode());
    }
    console.log('PASS native PostgreSQL + actual Composio SDK: Org/Team Manage-only exact profiles/accounts, collector SDK0, original intent and commit replay.');

    const unknownRecord = await create(), unknownIntent = intentForSharedComposioDesktopCase();
    const originalAccounts = new Set(provider.accounts.get(orgProfile.composioUserId)!.map(account => account.id));
    const linksBeforeUnknown = links();
    provider.loseNextLinkAcknowledgement();
    await assert.rejects(desktop.startSharedComposioDesktopOAuth(manager, unknownRecord.resource.connectionRef,
      { ...revisions(unknownRecord), intent: unknownIntent }), expectSharedComposioDesktopCode('outcome_unknown'));
    assert.equal(links(), linksBeforeUnknown + 1);
    const unknownAccounts = provider.accounts.get(orgProfile.composioUserId)!.filter(account => !originalAccounts.has(account.id));
    assert.equal(unknownAccounts.length, 1); assert.equal(unknownAccounts[0].status, 'INITIATED');
    const beforeUnknownReplay = provider.calls.length;
    const unknownFlow = await desktop.startSharedComposioDesktopOAuth(manager, unknownRecord.resource.connectionRef,
      { ...revisions(unknownRecord), intent: unknownIntent });
    assertSharedComposioDesktopSummary(unknownFlow, unknownRecord); assert.equal(unknownFlow.status, 'starting');
    assert.equal(unknownFlow.code, 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED'); assert.equal(provider.calls.length, beforeUnknownReplay);
    const unknownRows = await snapshotSharedComposioDesktopRows(sql, unknownRecord.resource.connectionRef);
    assert.equal(unknownRows.transactions.length, 1); assert.equal(unknownRows.commits.length, 0);
    const unknownRow = (unknownRows.transactions[0] as { value: { sealed_snapshot: string; state_hash: string; status: string } }).value;
    assert.equal(unknownRow.status, 'starting');
    const { openMcpSecret } = await import('../app/lib/mcp/secret-store');
    const baseline = await openMcpSecret(unknownRow.sealed_snapshot, { ownerUserId: manager.actor.userId,
      connectionId: unknownRow.state_hash, purpose: 'shared-composio-desktop-snapshot-v1',
      shared: { connectionRef: unknownRecord.resource.connectionRef, ownership: unknownRecord.resource.ownership } }) as { pendingAccountId: unknown; authorizationUrl: unknown };
    assert.equal(baseline.pendingAccountId, null); assert.equal(baseline.authorizationUrl, null);
    assert.equal(JSON.stringify(unknownRows).includes(unknownAccounts[0].id), false, 'The unacknowledged account must not appear in plaintext SQL.');
    await activateAndCollect(unknownRecord, unknownFlow);
    await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, unknownRecord.resource.connectionRef, unknownFlow.state), expectSharedComposioDesktopCode('outcome_unknown'));
    assert.deepEqual(await current(unknownRecord.resource.connectionRef), unknownRecord);
    assert.equal((await snapshotSharedComposioDesktopRows(sql, unknownRecord.resource.connectionRef)).commits.length, 0);
    assert.equal(links(), linksBeforeUnknown + 1); assert.equal(provider.accounts.get(orgProfile.composioUserId)!.length, originalAccounts.size + 1);
    assert.equal((await desktop.cancelSharedComposioDesktopOAuth(manager, unknownRecord.resource.connectionRef, unknownFlow.state)).status, 'cancelled');
    console.log('PASS actual provider account allocation with lost link ACK remains sealed/unconfirmed; original intent never relinks or guesses an account.');

    const unencrypted = await create(), beforeUnencrypted = provider.calls.length;
    const encryptionKey = process.env.INTEGRATIONS_ENV_MASTER_KEY;
    delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
    try {
      await assert.rejects(desktop.startSharedComposioDesktopOAuth(manager, unencrypted.resource.connectionRef,
        { ...revisions(unencrypted), intent: intentForSharedComposioDesktopCase() }), expectSharedComposioDesktopCode());
      assert(provider.calls.slice(beforeUnencrypted).every(call => call.path !== '/api/v3.1/tool_router/session'
        && !/\/tool_router\/session\/[^/]+\/link$/u.test(call.path)), 'Missing central encryption must prevent creating a provider session or link.');
      assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, unencrypted.resource.connectionRef), { transactions: [], commits: [] });
      assert.deepEqual(await current(unencrypted.resource.connectionRef), unencrypted);
    } finally { process.env.INTEGRATIONS_ENV_MASTER_KEY = encryptionKey; }

    const deniedRecord = await create(), deniedFlow = await start(deniedRecord), beforeDenied = await snapshotSharedComposioDesktopRows(sql, deniedRecord.resource.connectionRef);
    for (const wrong of [{ ...manager, authSessionId: 'session-manager-new' },
      { actor: owner, authSessionId: 'session-desktop-owner' },
      { actor: { userId: 'desktop-other', workspaceId: 'ws-desktop-other' }, authSessionId: 'session-desktop-other' },
      { ...manager, actor: { ...manager.actor, workspaceId: 'ws-desktop-owner' } }]) {
      const callsBefore = provider.calls.length;
      for (const operation of [desktop.getSharedComposioDesktopOAuthStatus, desktop.finalizeSharedComposioDesktopOAuth, desktop.cancelSharedComposioDesktopOAuth])
        await assert.rejects(operation(wrong, deniedRecord.resource.connectionRef, deniedFlow.state), expectSharedComposioDesktopCode());
      assert.equal(provider.calls.length, callsBefore); assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, deniedRecord.resource.connectionRef), beforeDenied);
    }
    const otherRef = await create();
    await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, otherRef.resource.connectionRef, deniedFlow.state), expectSharedComposioDesktopCode());
    const cancelled = await desktop.cancelSharedComposioDesktopOAuth(manager, deniedRecord.resource.connectionRef, deniedFlow.state);
    assertSharedComposioDesktopSummary(cancelled, deniedRecord); assert.equal(cancelled.status, 'cancelled');
    const callsBeforeLate = provider.calls.length;
    const beforeCancelledCallback = await snapshotSharedComposioDesktopRows(sql, deniedRecord.resource.connectionRef);
    await desktop.collectSharedComposioDesktopOAuthCallback(deniedFlow.state);
    assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, deniedRecord.resource.connectionRef), beforeCancelledCallback);
    assert.equal((await desktop.getSharedComposioDesktopOAuthStatus(manager, deniedRecord.resource.connectionRef, deniedFlow.state)).status, 'cancelled');
    assert.equal(provider.calls.length, callsBeforeLate); assert.deepEqual(await current(deniedRecord.resource.connectionRef), deniedRecord);
    assert.equal((await snapshotSharedComposioDesktopRows(sql, deniedRecord.resource.connectionRef)).commits.length, 0);

    for (const reason of ['grants', 'metadata', 'profile', 'credentials', 'session'] as const) {
      const record = await create(), flow = await start(record); await activateAndCollect(record, flow);
      if (reason === 'grants' || reason === 'metadata') await store.mutateSharedIntegrationConnection(owner, record.resource.connectionRef, {
        expectedMetadataRevision: record.resource.metadataRevision, expectedGrantsRevision: record.resource.grantsRevision, expectedBindingRevision: record.resource.bindingRevision,
        ...(reason === 'grants' ? { grants: [] } : { metadata: { description: 'Own metadata changed during consent' } }),
      });
      if (reason === 'profile') await sql.run('UPDATE composio_connection_profiles SET profile_revision=profile_revision+1 WHERE id=$1', [orgProfile.id]);
      if (reason === 'credentials') {
        if (fixture.managedMode) fixture.rotateManagedKey(true);
        else await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-org-composio-key-rotated' }], secretScope);
      }
      if (reason === 'session') await sql.run('UPDATE "session" SET expires_at=0 WHERE id=$1', [manager.authSessionId]);
      const before = await current(record.resource.connectionRef);
      await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, record.resource.connectionRef, flow.state), expectSharedComposioDesktopCode());
      assert.deepEqual(await current(record.resource.connectionRef), before);
      assert.equal((await snapshotSharedComposioDesktopRows(sql, record.resource.connectionRef)).commits.length, 0);
      if (reason === 'profile') await sql.run('UPDATE composio_connection_profiles SET profile_revision=profile_revision-1 WHERE id=$1', [orgProfile.id]);
      if (reason === 'credentials') {
        if (fixture.managedMode) fixture.rotateManagedKey(false);
        else await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: 'own-org-composio-key' }], secretScope);
      }
      if (reason === 'session') await sql.run('UPDATE "session" SET expires_at=$1 WHERE id=$2', [Date.now() + 2 * 60 * 60_000, manager.authSessionId]);
      if (reason !== 'grants') assert.equal((await desktop.cancelSharedComposioDesktopOAuth(manager, record.resource.connectionRef, flow.state)).status, 'cancelled');
    }
    const expiryRecord = await create(), expiryFlow = await start(expiryRecord);
    // Shorten only this own persisted deadline; the Engine and SDK use the actual clock.
    await sql.run('UPDATE composio_shared_desktop_oauth_transactions SET expires_at=created_at+1 WHERE connection_ref=$1', [expiryRecord.resource.connectionRef]);
    const expired = await desktop.getSharedComposioDesktopOAuthStatus(manager, expiryRecord.resource.connectionRef, expiryFlow.state);
    assertSharedComposioDesktopSummary(expired, expiryRecord); assert.equal(expired.status, 'expired');
    assert.deepEqual(await current(expiryRecord.resource.connectionRef), expiryRecord);

    for (const reason of ['session', 'flow'] as const) {
      const record = await create(), flow = await start(record); await activateAndCollect(record, flow);
      const deadline = Date.now() + 1500;
      if (reason === 'session') await sql.run('UPDATE "session" SET expires_at=$1 WHERE id=$2', [deadline, manager.authSessionId]);
      else await sql.run('UPDATE composio_shared_desktop_oauth_transactions SET expires_at=$1 WHERE connection_ref=$2', [deadline, record.resource.connectionRef]);
      let accountReadBeforeExpiry = false;
      provider.rotateOnEndpoint('/api/v3.1/connected_accounts', async () => {
        assert(Date.now() < deadline, 'The real SDK account read must start while the original authority is still live.');
        accountReadBeforeExpiry = true;
        await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 25)));
      });
      try {
        await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, record.resource.connectionRef, flow.state), expectSharedComposioDesktopCode());
        assert.equal(accountReadBeforeExpiry, true); assert(Date.now() >= deadline);
        assert.deepEqual(await current(record.resource.connectionRef), record);
        assert.equal((await snapshotSharedComposioDesktopRows(sql, record.resource.connectionRef)).commits.length, 0);
      } finally {
        if (reason === 'session') await sql.run('UPDATE "session" SET expires_at=$1 WHERE id=$2', [Date.now() + 2 * 60 * 60_000, manager.authSessionId]);
      }
      assert.equal((await desktop.cancelSharedComposioDesktopOAuth(manager, record.resource.connectionRef, flow.state)).status, reason === 'flow' ? 'expired' : 'cancelled');
    }
    console.log('PASS exact original session/ref/actor, cancellation/late return, expiry and current grant/CAS/profile/credential revocation fences.');

    const publicOnly = await create(false, 'duckduckgo'), beforePublicLinks = links();
    const publicStarted = await desktop.startSharedComposioDesktopOAuth(manager, publicOnly.resource.connectionRef,
      { ...revisions(publicOnly), intent: intentForSharedComposioDesktopCase() });
    assert.deepEqual(publicStarted, { connectionRef: publicOnly.resource.connectionRef, noAuth: true });
    const publicBound = await current(publicOnly.resource.connectionRef);
    assert.equal(publicBound.resource.bindingRevision, publicOnly.resource.bindingRevision + 1);
    assert.equal(publicBound.backend.source, 'composio');
    if (publicBound.backend.source === 'composio') { assert.equal(publicBound.backend.accountBinding, 'no_auth'); assert.equal(publicBound.backend.connectedAccountId, null); }
    assert.equal(links(), beforePublicLinks);
    assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, publicOnly.resource.connectionRef), { transactions: [], commits: [] });

    const rolledBack = await create(), rollbackFlow = await start(rolledBack); await activateAndCollect(rolledBack, rollbackFlow);
    await sql.run("CREATE FUNCTION own_composio_desktop_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'own desktop receipt rollback'; END $$");
    await sql.run('CREATE TRIGGER own_composio_desktop_receipt_failure BEFORE INSERT ON composio_shared_desktop_oauth_commits FOR EACH ROW EXECUTE FUNCTION own_composio_desktop_receipt_failure()');
    try {
      await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, rolledBack.resource.connectionRef, rollbackFlow.state), expectSharedComposioDesktopCode());
      assert.deepEqual(await current(rolledBack.resource.connectionRef), rolledBack);
      assert.equal((await snapshotSharedComposioDesktopRows(sql, rolledBack.resource.connectionRef)).commits.length, 0);
    } finally {
      await sql.run('DROP TRIGGER own_composio_desktop_receipt_failure ON composio_shared_desktop_oauth_commits');
      await sql.run('DROP FUNCTION own_composio_desktop_receipt_failure()');
    }
    const beforeRetryLinks = links();
    assert.equal((await desktop.finalizeSharedComposioDesktopOAuth(manager, rolledBack.resource.connectionRef, rollbackFlow.state)).status, 'completed');
    assert.equal(links(), beforeRetryLinks); assert.equal((await snapshotSharedComposioDesktopRows(sql, rolledBack.resource.connectionRef)).commits.length, 1);

    const lostAck = await create(), lostAckFlow = await start(lostAck); await activateAndCollect(lostAck, lostAckFlow);
    const beforeLostAckLinks = links();
    fixture.loseNextPublicationCommitAcknowledgment();
    await assert.rejects(desktop.finalizeSharedComposioDesktopOAuth(manager, lostAck.resource.connectionRef, lostAckFlow.state),
      error => error instanceof Error && error.message === 'OWN_PUBLICATION_COMMIT_ACK_LOST');
    assert.equal(fixture.publicationAcknowledgmentsLost(), 1);
    const acknowledgedAfterLoss = await current(lostAck.resource.connectionRef);
    assert.equal(acknowledgedAfterLoss.resource.bindingRevision, lostAck.resource.bindingRevision + 1);
    const committedAfterLoss = await snapshotSharedComposioDesktopRows(sql, lostAck.resource.connectionRef);
    assert.equal(committedAfterLoss.commits.length, 1);
    assert.equal((await desktop.getSharedComposioDesktopOAuthStatus(manager, lostAck.resource.connectionRef, lostAckFlow.state)).status, 'completed');
    assert.equal((await desktop.finalizeSharedComposioDesktopOAuth(manager, lostAck.resource.connectionRef, lostAckFlow.state)).status, 'completed');
    assert.equal((await desktop.startSharedComposioDesktopOAuth(manager, lostAck.resource.connectionRef,
      { ...revisions(lostAck), intent: lostAckFlow.intent }) as DesktopSummary).state, lostAckFlow.state);
    assert.deepEqual(await snapshotSharedComposioDesktopRows(sql, lostAck.resource.connectionRef), committedAfterLoss);
    assert.deepEqual(await current(lostAck.resource.connectionRef), acknowledgedAfterLoss); assert.equal(links(), beforeLostAckLinks);
    assert(provider.calls.every(call => !call.path.startsWith('/api/v3.1/tools/execute/')));
    const permittedKeys = fixture.managedMode ? ['own-managed-composio-key', 'own-managed-composio-key-rotated'] : ['own-org-composio-key', 'own-org-composio-key-rotated'];
    assert(provider.calls.every(call => permittedKeys.includes(call.apiKey ?? '')));
    assert.equal((await sql.get('SELECT COUNT(*)::integer AS count FROM pi_sessions') as { count: number }).count, 0);
    console.log('PASS real SQL rollback and committed-but-lost adapter ACK recover only the same flow; no relink, business execution or PI session.');

    const migrationTables = ['composio_shared_desktop_oauth_transactions', 'composio_shared_desktop_oauth_commits',
      'integration_connection_resources', 'integration_connection_grants'] as const;
    // This database was acknowledged blank before seeding. All rows in these four tables belong to this fixture.
    // Full JSON row snapshots remain in RAM and include encrypted baselines, revisions, grants and terminal receipts.
    const migrationBaseline = await Promise.all(migrationTables.map(table => sql.all(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`)));
    assert(migrationBaseline.every(rows => rows.length <= 100));
    const callsBeforeMigrations = provider.calls.length;
    for (let repetition = 0; repetition < 2; repetition += 1) {
      await fixture.repeatMigrations();
      const afterMigration = await Promise.all(migrationTables.map(table => sql.all(`SELECT to_jsonb(row) AS value FROM ${table} row ORDER BY to_jsonb(row)::text`)));
      assert.deepEqual(afterMigration, migrationBaseline, 'Actual additive migration replay must preserve every own flow, publication receipt, connection and grant row.');
      assert.equal(provider.calls.length, callsBeforeMigrations, 'SQL migration replay must make zero SDK requests.');
    }
    console.log('PASS two actual native SQL migration replays preserve all own flow/receipt/connection/grant rows and make zero SDK requests.');
  } finally { await fixture.sql.close(); await fixture.close(); }
}

main().catch(error => {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(error.code) ? error.code : 'OWN_FIXTURE_FAILED';
  console.error(`FAIL shared Composio desktop server fixture (${code}); assertion values and provider responses are private.`);
  if (error instanceof Error) {
    const frames = error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).slice(0, 6).map(line => line.slice(0, 500)) ?? [];
    for (const frame of frames) console.error(frame);
  }
  process.exitCode = 1;
});
