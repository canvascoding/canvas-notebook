import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createPiTestDatabase } from './helpers/pi-test-database';
import type { SqlConnection } from '../app/lib/db';
import type { IntegrationConnectionRecord } from '../app/lib/integration-tools/connections/contracts';
import type { SharedMcpDesktopOAuthSummary } from '../app/lib/mcp/shared-desktop-oauth';
import type { OAuthTokenRecord } from '../app/lib/mcp/oauth';

const expectCode = (code: string) => (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === code;

async function providerFixture() {
  let origin = '', requests = 0, failNextToken = false, dropNextToken = false;
  let hold: { entered: () => void; wait: Promise<void> } | null = null;
  const forms: URLSearchParams[] = [], errors: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      requests += 1;
      if (request.url === '/.well-known/oauth-authorization-server') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true })); return;
      }
      if (request.url === '/.well-known/oauth-protected-resource/mcp') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] })); return;
      }
      if (request.url === '/token' && request.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); forms.push(form);
        assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('client_id'), 'fixture-client');
        assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:3001/api/mcp/oauth/callback'); assert(form.get('code_verifier'));
        assert.equal(form.get('resource'), `${origin}/mcp`);
        const delayed = hold; hold = null; if (delayed) { delayed.entered(); await delayed.wait; }
        if (dropNextToken) { dropNextToken = false; request.socket.destroy(); return; }
        response.setHeader('Content-Type', 'application/json');
        if (failNextToken) { failNextToken = false; response.statusCode = 503; response.end(JSON.stringify({ error: 'temporarily_unavailable' })); return; }
        response.end(JSON.stringify({ access_token: `own-fixture-token-${forms.length}`, token_type: 'Bearer', expires_in: 3600 })); return;
      }
      response.statusCode = 404; response.end('own fixture not found');
    } catch (error) { errors.push(error); response.statusCode = 500; response.end('own fixture failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  return { origin, url: `${origin}/mcp`, forms, errors, requests: () => requests,
    fail: () => { failNextToken = true; },
    drop: () => { dropNextToken = true; },
    hold: () => { let entered!: () => void, release!: () => void;
      const entry = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      hold = { entered, wait }; return { entered: entry, release }; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** PGlite has one SQL engine, so independent production leases are serialized, not nested transactions. */
function createLeasedTransport(database: Awaited<ReturnType<typeof createPiTestDatabase>>) {
  let tail = Promise.resolve(), queries = 0, leases = 0, commits = 0;
  let failCommit = false;
  const engine = database.getPostgresRuntimeQueryable(), originalQuery = engine.query.bind(engine);
  engine.query = ((...args: Parameters<typeof engine.query>) => { queries += 1; return originalQuery(...args); }) as typeof engine.query;
  return { ...database, queries: () => queries, leases: () => leases, commits: () => commits, failNextCommit: () => { failCommit = true; },
    openDb: async (): Promise<SqlConnection> => {
      const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
      leases += 1; const actual = await database.openDb(); let closed = false;
      return { get: actual.get, all: actual.all,
        run: async (sql, values = []) => { if (sql === 'COMMIT' && failCommit) { failCommit = false; throw new Error('fixture-SQL-COMMIT-failed'); }
          const result = await actual.run(sql, values); if (sql === 'COMMIT') commits += 1; return result; },
        close: async () => { if (!closed) { closed = true; await actual.close(); release(); } } };
    } };
}

async function seedAuthority(sql: SqlConnection) {
  for (const id of ['owner', 'manager', 'other']) {
    await sql.run('INSERT INTO "user" (id,name,email,role,banned,email_verified,created_at,updated_at) VALUES ($1,$1,$2,\'user\',0,1,1000,1000)', [id, `${id}@desktop.example.test`]);
  }
  await sql.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('desktop-org','owner','team',1,1000,1000)");
  for (const id of ['owner', 'manager', 'other']) {
    await sql.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('desktop-org',$1,$2,'active',0,1000,1000)", [id, id === 'owner' ? 'owner' : 'member']);
    await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'desktop-org','personal',$2,$3,$2,'active',1000,1000)", [`ws-${id}`, id, `workspaces/${id}/files`]);
    await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,1000,1000)', [`session-${id}`, id, randomUUID(), Date.now() + 2 * 60 * 60_000]);
  }
  await sql.run("INSERT INTO canvas_workspaces (id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES ('desktop-team','desktop-org','team','workspaces/team/files','Own team','active',1000,1000)");
}

function assertSafeSummary(value: SharedMcpDesktopOAuthSummary, backendId: string) {
  assert.deepEqual(Object.keys(value).sort(), ['connectionRef', 'expiresAt', 'state', 'status', ...(value.authorizationUrl ? ['authorizationUrl'] : []),
    ...(value.code ? ['code', 'error'] : [])].sort());
  assert(!JSON.stringify(value).includes(backendId));
  assert.doesNotMatch(JSON.stringify(value), /codeVerifier|authSessionId|own-fixture-token|fixture-code|initiatingUserId|configHash/u);
  if (value.status !== 'waiting') assert.equal('authorizationUrl' in value, false);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-shared-desktop-engine-')), identity = await fs.lstat(root);
  const provider = await providerFixture();
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/unused_isolated_fixture',
    CANVAS_INSTANCE_ID: 'shared-desktop-engine-fixture', CANVAS_ORGANIZATION_ID: 'desktop-org', CANVAS_DEPLOYMENT_MODE: 'team',
    CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_MANAGED_SERVICES_ENABLED: 'false', MCP_ALLOW_PRIVATE_NETWORK: 'true',
    MCP_ALLOW_INSECURE_HTTP: 'true', MCP_ALLOW_STDIO: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), BASE_URL: 'http://127.0.0.1:3001', NODE_ENV: 'test' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const database = await createPiTestDatabase(), transport = createLeasedTransport(database);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown }, originalLoad = loader._load;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name)) return transport;
    return originalLoad(name, parent, isMain);
  };
  const sql = await database.openDb(), originalRename = fs.rename, originalNow = Date.now;
  try {
    await seedAuthority(sql);
    const beforeImport = transport.queries();
    const desktop = await import('../app/lib/mcp/shared-desktop-oauth');
    assert.equal(transport.queries(), beforeImport, 'Cold shared collector import performs zero SQL.');
    const shared = await import('../app/lib/mcp/shared-connections'), routing = await import('../app/lib/mcp/shared-oauth');
    const store = await import('../app/lib/integration-tools/connections/store'), access = await import('../app/lib/mcp/shared-access');
    const oauth = await import('../app/lib/mcp/oauth'), credentials = await import('../app/lib/mcp/credential-storage');
    const storage = await import('../app/lib/mcp/storage'), ledger = await import('../app/lib/mcp/desktop-oauth-commit');
    const lifecycle = await import('../app/lib/mcp/oauth-lifecycle');
    const owner = { userId: 'owner', workspaceId: 'ws-owner' }, manager = { userId: 'manager', workspaceId: 'ws-manager' };
    const initiator = { actor: manager, authSessionId: 'session-manager' };
    const revisions = (record: IntegrationConnectionRecord) => ({ metadataRevision: record.resource.metadataRevision,
      grantsRevision: record.resource.grantsRevision, bindingRevision: record.resource.bindingRevision });
    const current = async (ref: string) => { const value = await store.getIntegrationConnectionRecord(ref); assert(value); return value; };
    const create = async (team = false) => shared.createSharedMcpConnection(owner, { ownership: team
      ? { type: 'team', organizationId: 'desktop-org', workspaceId: 'desktop-team' } : { type: 'organization', organizationId: 'desktop-org' },
      displayName: `Own OAuth ${randomUUID()}`, accessMode: 'restricted', allowedToolNames: [], secrets: [],
      grants: [{ targetType: 'user', targetId: 'manager', canUse: false, canManage: true, allowedToolNames: null }],
      config: { url: provider.url, auth: 'oauth', oauth: { issuer: provider.origin, clientId: 'fixture-client' } } });
    const start = async (record: IntegrationConnectionRecord, authSessionId = initiator.authSessionId) => routing.startSharedMcpOAuth(manager,
      record.resource.connectionRef, revisions(await current(record.resource.connectionRef)), environment.BASE_URL, { desktop: { authSessionId } });
    const collect = async (state: string) => desktop.tryReceiveSharedMcpDesktopOAuthCallback({ state, code: 'fixture-code', issuer: provider.origin });
    const locator = (state: string) => `shared-desktop-oauth-transactions/${createHash('sha256').update(state).digest('hex')}.json`;
    const connectionId = (record: IntegrationConnectionRecord) => { assert.equal(record.backend.source, 'mcp');
      if (record.backend.source !== 'mcp') throw new Error('Expected actual MCP backend.'); return record.backend.connectionId; };

    if (process.argv.includes('--ambiguous-exchange')) {
      for (const failure of ['http', 'lost-ack'] as const) {
        const record = await create(), started = await start(record); await collect(started.state);
        const exchanged = provider.forms.length; if (failure === 'http') provider.fail(); else provider.drop();
        await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, record.resource.connectionRef, started.state), expectCode(failure === 'http' ? 'provider_unavailable' : 'network_error'));
        const retried = await desktop.finalizeSharedMcpDesktopOAuth(initiator, record.resource.connectionRef, started.state);
        console.log(`Ambiguous ${failure} exchange observed: ${provider.forms.length - exchanged} POSTs; retry status=${retried.status}.`);
        assert.equal(provider.forms.length - exchanged, 1, 'A lost/failed provider acknowledgement must never replay the one-time code POST.');
        assert.equal(retried.status, 'failed'); assert.equal((await current(record.resource.connectionRef)).resource.bindingRevision, record.resource.bindingRevision);
      }
      console.log('PASS durable one-shot exchange after provider acknowledgement failure.'); return;
    }

    const first = await create(), ref = first.resource.connectionRef, backend = connectionId(first);
    const manage = await store.authorizeIntegrationConnection(manager, ref, 'manage'); assert.equal(manage.access.canUse, false);
    const beforeDeniedStart = provider.requests();
    for (const invalidSession of ['session-other', 'absent-session']) await assert.rejects(start(first, invalidSession), expectCode('CONNECTION_ACCESS_DENIED'));
    assert.equal(provider.requests(), beforeDeniedStart, 'Wrong/absent initiating sessions cause no provider requests.');
    const started = await start(first); assert.equal(started.desktop, true); assert.equal(started.redirectUri, `${environment.BASE_URL}/api/mcp/oauth/callback`);
    assert.match(started.state, /^desktop_[A-Za-z0-9_-]{32}$/u);
    assertSafeSummary(await desktop.getSharedMcpDesktopOAuthStatus(initiator, ref, started.state), backend);
    for (const wrong of [{ actor: { userId: 'other', workspaceId: 'ws-other' }, authSessionId: 'session-other' },
      { ...initiator, authSessionId: 'session-owner' }, { ...initiator, actor: { ...manager, workspaceId: 'ws-owner' } }]) {
      await assert.rejects(desktop.getSharedMcpDesktopOAuthStatus(wrong, ref, started.state), expectCode('CONNECTION_ACCESS_DENIED'));
    }
    await assert.rejects(desktop.getSharedMcpDesktopOAuthStatus(initiator, `canvas-connection:${randomUUID()}`, started.state), expectCode('CONNECTION_ACCESS_DENIED'));
    const beforeCollect = { queries: transport.queries(), leases: transport.leases(), requests: provider.requests(), exchanges: provider.forms.length };
    const received = await collect(started.state); assert(received); assert.equal(received.status, 'callback_received'); assertSafeSummary(received, backend);
    assert.deepEqual({ queries: transport.queries(), leases: transport.leases(), requests: provider.requests(), exchanges: provider.forms.length }, beforeCollect,
      'Public collection and sealing perform zero SQL, provider requests and exchanges.');
    const encrypted = await fs.readFile(storage.resolveMcpStoragePath(locator(started.state), { legacy: true }), 'utf8');
    assert.doesNotMatch(encrypted, /fixture-code|codeVerifier|session-manager|"manager"/u);
    await assert.rejects(collect(started.state), expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID'));
    const finalized = await Promise.all([desktop.finalizeSharedMcpDesktopOAuth(initiator, ref, started.state), desktop.finalizeSharedMcpDesktopOAuth(initiator, ref, started.state)]);
    assert(finalized.every(value => value.status === 'completed')); finalized.forEach(value => assertSafeSummary(value, backend));
    assert.equal(provider.forms.length, beforeCollect.exchanges + 1); assert.equal((await current(ref)).resource.bindingRevision, first.resource.bindingRevision + 1);
    assert(await ledger.readSharedMcpDesktopOAuthCommit(sql, started.state));
    const terminal = await credentials.readMcpCredentialJson<Record<string, unknown>>(locator(started.state), { legacy: true });
    assert(terminal); assert.equal('response' in terminal, false);
    assert.equal((await desktop.getSharedMcpDesktopOAuthStatus(initiator, ref, started.state)).status, 'completed');
    const actualTokenScope = access.sharedMcpScope(await store.authorizeIntegrationConnection(manager, ref, 'manage'));
    const tokenPath = `connections/${backend}/tokens.json`, token = await credentials.readMcpCredentialJson<OAuthTokenRecord>(tokenPath, actualTokenScope);
    assert(token); const tokenChecks = provider.forms.length;
    for (const patch of [{ authorizationState: `desktop_${randomBytes(24).toString('base64url')}` }, { issuer: 'https://wrong.example.test' },
      { clientId: 'wrong-client' }, { resource: `${provider.origin}/wrong-resource` }]) {
      await credentials.writeMcpCredentialJson(tokenPath, { ...token, ...patch }, actualTokenScope);
      await assert.rejects(desktop.getSharedMcpDesktopOAuthStatus(initiator, ref, started.state), expectCode('CONNECTION_BINDING_CHANGED'));
      assert.equal(provider.forms.length, tokenChecks, 'Lifecycle state alone cannot substitute for the exact sealed token binding.');
    }
    await credentials.writeMcpCredentialJson(tokenPath, token, actualTokenScope);
    assert.equal((await desktop.getSharedMcpDesktopOAuthStatus(initiator, ref, started.state)).status, 'completed');
    console.log('PASS actual Manage-only authority, original web-session/context binding, static public collect and concurrent exactly-once publication.');

    for (const primaryOnly of [false, true]) {
      const markerRecord = await create(), markerStart = await start(markerRecord); await collect(markerStart.state);
      const primary = storage.resolveMcpStoragePath(locator(markerStart.state), { legacy: true });
      const beforeMarker = provider.forms.length; let markerFailures = 0;
      fs.rename = async (source, destination) => { if (String(destination).startsWith(`${root}${path.sep}`) && String(destination).endsWith(locator(markerStart.state))
        && (!primaryOnly || String(destination) === primary)) { markerFailures += 1; throw new Error('fixture-exchange-intent-FS-ACK-failed'); } return originalRename(source, destination); };
      await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, markerRecord.resource.connectionRef, markerStart.state), primaryOnly
        ? expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID') : /fixture-exchange-intent-FS-ACK-failed/u);
      fs.rename = originalRename; assert.equal(markerFailures, primaryOnly ? 1 : 2); assert.equal(provider.forms.length, beforeMarker, 'Unacknowledged durable exchange intent causes zero token POSTs.');
      assert.equal((await credentials.readMcpCredentialJson<Record<string, unknown>>(locator(markerStart.state), { legacy: true }))?.exchangeAttempted, false);
      assert.equal((await desktop.finalizeSharedMcpDesktopOAuth(initiator, markerRecord.resource.connectionRef, markerStart.state)).status, 'completed');
      assert.equal(provider.forms.length, beforeMarker + 1);
    }
    console.log('PASS durable exchange-intent write precedes token HTTP and a failed marker acknowledgement exchanges zero times.');

    for (const primaryOnly of [false, true]) {
      const fsRecord = await create(true), fsStart = await start(fsRecord); await collect(fsStart.state);
      const beforeFinishCommit = transport.commits(), primary = storage.resolveMcpStoragePath(locator(fsStart.state), { legacy: true }); let failedRenames = 0;
      fs.rename = async (source, destination) => { if (transport.commits() > beforeFinishCommit && String(destination).startsWith(`${root}${path.sep}`)
        && String(destination).endsWith(locator(fsStart.state)) && (!primaryOnly || String(destination) === primary)) { failedRenames += 1; throw new Error('fixture-completion-FS-ACK-failed'); }
        return originalRename(source, destination); };
      const beforeFS = provider.forms.length;
      await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, fsRecord.resource.connectionRef, fsStart.state), primaryOnly
        ? expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID') : /fixture-completion-FS-ACK-failed/u);
      fs.rename = originalRename;
      assert.equal(failedRenames, primaryOnly ? 1 : 2, 'The controlled fault proves stale-primary fallback ACK and full storage failure separately.');
      assert.equal((await current(fsRecord.resource.connectionRef)).resource.bindingRevision, fsRecord.resource.bindingRevision + 1);
      assert(await ledger.readSharedMcpDesktopOAuthCommit(sql, fsStart.state));
      const pendingAfterCommit = await credentials.readMcpCredentialJson<Record<string, unknown>>(locator(fsStart.state), { legacy: true });
      assert.equal(pendingAfterCommit?.status, 'callback_received'); assert(pendingAfterCommit?.response);
      if (primaryOnly) {
        Date.now = () => Date.parse(fsStart.expiresAt) + 1;
        const expiryQueries = transport.queries();
        assert.equal((await collect(fsStart.state))?.status, 'expired'); assert.equal(transport.queries(), expiryQueries);
        assert.equal((await credentials.readMcpCredentialJson<Record<string, unknown>>(locator(fsStart.state), { legacy: true }))?.response, undefined);
      }
      assert.equal((await desktop.getSharedMcpDesktopOAuthStatus(initiator, fsRecord.resource.connectionRef, fsStart.state)).status, 'completed');
      Date.now = originalNow;
      assert.equal(provider.forms.length, beforeFS + 1, 'Exact committed receipt recovers a lost file acknowledgement without re-exchange.');
    }
    console.log('PASS organization/team completion after SQL COMMIT only, with exact-ledger recovery of pending sealed code.');

    for (const unrelated of [false, true]) {
      const record = await create(), flow = await start(record); await collect(flow.state); const exchanges = provider.forms.length;
      transport.failNextCommit();
      await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, record.resource.connectionRef, flow.state), /fixture-SQL-COMMIT-failed/u);
      assert.equal((await current(record.resource.connectionRef)).resource.bindingRevision, record.resource.bindingRevision);
      assert.equal(await ledger.readSharedMcpDesktopOAuthCommit(sql, flow.state), null);
      const pending = await credentials.readMcpCredentialJson<Record<string, unknown>>(locator(flow.state), { legacy: true });
      assert.equal(pending?.status, 'callback_received'); assert(pending?.response);
      const fresh = await store.authorizeIntegrationConnection(manager, record.resource.connectionRef, 'manage'), scope = access.sharedMcpScope(fresh);
      const committedToken = await oauth.getMcpOAuthStatus(connectionId(record), null, scope); assert.equal(committedToken.authorized, true); assert.equal(committedToken.lastCompletedState, flow.state);
      const publication = await import('../app/lib/mcp/shared-publication');
      const actualRead = await store.authorizeIntegrationConnection(manager, record.resource.connectionRef, 'inspect');
      await assert.rejects(publication.assertSharedMcpBindingPublished(actualRead), expectCode('binding_changed'));
      if (unrelated) {
        await store.publishIntegrationConnectionBinding(manager, record.resource.connectionRef, revisions(record), record.backend);
        await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, record.resource.connectionRef, flow.state), expectCode('CONNECTION_BINDING_CHANGED'));
        assert.equal(await ledger.readSharedMcpDesktopOAuthCommit(sql, flow.state), null);
      } else {
        assert.equal((await desktop.finalizeSharedMcpDesktopOAuth(initiator, record.resource.connectionRef, flow.state)).status, 'completed');
        assert(await ledger.readSharedMcpDesktopOAuthCommit(sql, flow.state));
      }
      assert.equal(provider.forms.length, exchanges + 1, 'Token commit plus rollback permits only exact-flow SQL publication, never another exchange.');
    }
    console.log('PASS rollback preserves pending proof and execution fence; unrelated same-backend bind/history cannot manufacture completion.');

    const cancelRecord = await create(), cancelled = await start(cancelRecord);
    assert.equal((await desktop.cancelSharedMcpDesktopOAuth(initiator, cancelRecord.resource.connectionRef, cancelled.state)).status, 'cancelled');
    await assert.rejects(collect(cancelled.state), expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID'));
    const providerCancelled = await start(cancelRecord);
    assert.equal((await desktop.tryReceiveSharedMcpDesktopOAuthCallback({ state: providerCancelled.state, error: 'access_denied', issuer: provider.origin }))?.status, 'cancelled');
    const badIssuer = await start(cancelRecord);
    await assert.rejects(desktop.tryReceiveSharedMcpDesktopOAuthCallback({ state: badIssuer.state, code: 'fixture-code', issuer: 'https://wrong.example.test' }), expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID'));
    assert.equal((await desktop.getSharedMcpDesktopOAuthStatus(initiator, cancelRecord.resource.connectionRef, badIssuer.state)).status, 'failed');
    const expired = await start(cancelRecord); const expirationExchanges = provider.forms.length;
    Date.now = () => Date.parse(expired.expiresAt) + 1;
    assert.equal((await desktop.getSharedMcpDesktopOAuthStatus(initiator, cancelRecord.resource.connectionRef, expired.state)).status, 'expired'); Date.now = originalNow;
    assert.equal(provider.forms.length, expirationExchanges);
    assert.equal(await desktop.tryReceiveSharedMcpDesktopOAuthCallback({ state: `desktop_${randomBytes(24).toString('base64url')}`, code: 'fixture-code', issuer: provider.origin }), null);
    const malformedState = `desktop_${randomBytes(24).toString('base64url')}`;
    await credentials.writeMcpCredentialJson(locator(malformedState), { connectionId: backend, organizationId: 'desktop-org', state: malformedState, version: 99 }, { legacy: true });
    await assert.rejects(desktop.tryReceiveSharedMcpDesktopOAuthCallback({ state: malformedState, code: 'fixture-code', issuer: provider.origin }), expectCode('CONNECTION_DESKTOP_OAUTH_STATE_INVALID'));
    await storage.removeMcpStoragePath(locator(malformedState), { legacy: true });
    console.log('PASS exact absent-namespace fallback, malformed fail-closed storage, cancellation, callback replay, issuer and expiry.');

    const revokedRecord = await create(), revoked = await start(revokedRecord); await collect(revoked.state);
    await store.mutateSharedIntegrationConnection(owner, revokedRecord.resource.connectionRef, { expectedMetadataRevision: revokedRecord.resource.metadataRevision,
      expectedGrantsRevision: revokedRecord.resource.grantsRevision, expectedBindingRevision: revokedRecord.resource.bindingRevision, grants: [] });
    const beforeRevoke = provider.forms.length;
    await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, revokedRecord.resource.connectionRef, revoked.state), expectCode('CONNECTION_ACCESS_DENIED'));
    const changedRecord = await create(), changed = await start(changedRecord); await collect(changed.state);
    await store.mutateSharedIntegrationConnection(owner, changedRecord.resource.connectionRef, { expectedMetadataRevision: changedRecord.resource.metadataRevision,
      expectedGrantsRevision: changedRecord.resource.grantsRevision, expectedBindingRevision: changedRecord.resource.bindingRevision, metadata: { displayName: 'Own changed setup' } });
    await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, changedRecord.resource.connectionRef, changed.state), expectCode('CONNECTION_BINDING_CHANGED'));
    const generationRecord = await create(), generation = await start(generationRecord); await collect(generation.state);
    const generationAuth = await store.authorizeIntegrationConnection(manager, generationRecord.resource.connectionRef, 'manage');
    await lifecycle.invalidateMcpOAuthGeneration(connectionId(generationRecord), access.sharedMcpScope(generationAuth));
    await assert.rejects(desktop.finalizeSharedMcpDesktopOAuth(initiator, generationRecord.resource.connectionRef, generation.state),
      error => error instanceof oauth.McpOAuthError && /invalidated/u.test(error.message));
    assert.equal(provider.forms.length, beforeRevoke, 'Current grant/CAS/generation changes deny before any token POST.');

    const expiryRecord = await create(); await sql.run('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,\'manager\',$2,$3,1000,1000)', ['short-session', randomUUID(), Date.now() + 5000]);
    const short = await start(expiryRecord, 'short-session'); await collect(short.state); const delayed = provider.hold();
    const shortInitiator = { ...initiator, authSessionId: 'short-session' }, finalizing = desktop.finalizeSharedMcpDesktopOAuth(shortInitiator, expiryRecord.resource.connectionRef, short.state);
    const failure = assert.rejects(finalizing, expectCode('CONNECTION_ACCESS_DENIED')); await delayed.entered;
    const enteredAt = originalNow(); Date.now = () => enteredAt + 6000; delayed.release(); await failure; Date.now = originalNow;
    assert.equal((await current(expiryRecord.resource.connectionRef)).resource.bindingRevision, expiryRecord.resource.bindingRevision);
    const expiryAuth = await store.authorizeIntegrationConnection(manager, expiryRecord.resource.connectionRef, 'manage');
    assert.equal((await oauth.getMcpOAuthStatus(connectionId(expiryRecord), null, access.sharedMcpScope(expiryAuth))).authorized, false);
    console.log('PASS fresh grant/setup/generation checks and real original Session expiry fenced again after token HTTP response.');

    const publicExpiredRecord = await create(), publicExpired = await start(publicExpiredRecord);
    const expiredScope = access.sharedMcpScope(await store.authorizeIntegrationConnection(manager, publicExpiredRecord.resource.connectionRef, 'manage'));
    const expiredTempPath = storage.resolveMcpStoragePath(`oauth-states/${publicExpired.state}.json`, expiredScope);
    assert((await fs.lstat(expiredTempPath)).isFile());
    Date.now = () => Date.parse(publicExpired.expiresAt) + 1;
    const publicExpiredQueries = transport.queries(), publicExpiredRequests = provider.requests();
    assert.equal((await collect(publicExpired.state))?.status, 'expired');
    assert.equal(transport.queries(), publicExpiredQueries); assert.equal(provider.requests(), publicExpiredRequests);
    await assert.rejects(fs.lstat(expiredTempPath), { code: 'ENOENT' }); Date.now = originalNow;

    // Expire remaining denied flows before checking the per-creator bound, then keep eight actual sealed states.
    const boundedRecord = await create(), now = originalNow(); Date.now = () => now + 11 * 60_000;
    const bounded: Awaited<ReturnType<typeof start>>[] = [];
    for (let index = 0; index < 8; index += 1) bounded.push(await start(boundedRecord));
    await assert.rejects(start(boundedRecord), expectCode('CONNECTION_DESKTOP_OAUTH_BUSY'));
    const boundedScope = access.sharedMcpScope(await store.authorizeIntegrationConnection(manager, boundedRecord.resource.connectionRef, 'manage'));
    const stateFiles = await fs.readdir(storage.resolveMcpStoragePath('oauth-states', boundedScope));
    assert.equal(stateFiles.filter(name => /^desktop_[A-Za-z0-9_-]{32}\.json$/u.test(name)).length, 8,
      'A rejected ninth creation leaves no unindexed provider temporary state.');
    await desktop.cancelSharedMcpDesktopOAuth(initiator, boundedRecord.resource.connectionRef, bounded[0].state);
    await assert.rejects(fs.lstat(storage.resolveMcpStoragePath(`oauth-states/${bounded[0].state}.json`, boundedScope)), { code: 'ENOENT' });
    assert(await start(boundedRecord));
    Date.now = () => now + 2 * 60 * 60_000 - 20_000;
    const afterCleanup = await start(boundedRecord); assert(afterCleanup);
    await assert.rejects(fs.lstat(storage.resolveMcpStoragePath(locator(bounded[0].state), { legacy: true })), { code: 'ENOENT' });
    for (const flow of bounded) await assert.rejects(fs.lstat(storage.resolveMcpStoragePath(`oauth-states/${flow.state}.json`, boundedScope)), { code: 'ENOENT' });
    Date.now = originalNow;
    console.log('PASS creator-bounded pending states, failed ninth-start cleanup and static expiry/cancel/terminal-TTL removal of exact temporary state.');
    assert.equal(provider.errors.length, 0); console.log('Shared desktop OAuth engine fixture passed (real isolated PGlite, own HTTP OAuth, no authority mocks).');
  } finally {
    Date.now = originalNow; fs.rename = originalRename; loader._load = originalLoad;
    await sql.close(); await database.close(); await provider.close();
    const currentIdentity = await fs.lstat(root);
    assert(currentIdentity.isDirectory() && !currentIdentity.isSymbolicLink() && currentIdentity.dev === identity.dev && currentIdentity.ino === identity.ino,
      'Own DATA identity changed; preserve it rather than removing an unverified directory.');
    await fs.rm(root, { recursive: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
