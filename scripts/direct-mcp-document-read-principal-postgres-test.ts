import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { DirectMcpDocumentReadHistoricalOrigin, DirectMcpDocumentReadPrincipal,
  DirectMcpDocumentReadPrincipalAccess } from '../app/lib/mcp/server/document-read-principal';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
// Actual isolated PG18 / Better Auth JWKS probes. No manufactured Web session,
// verifier response, Principal, granted claims DTO or public read acceptance.
let stage = 'private configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `mcp_document_read_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^mcp_document_read_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-document-read-'));
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let created = false, cases = 0, fetches = 0;
  let pool: { end: () => Promise<void> } | undefined;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=mcp-document-read-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const connection = (client: Client): SqlConnection => ({
    get: async (sql, values) => (await client.query(sql, values)).rows[0],
    all: async (sql, values) => (await client.query(sql, values)).rows,
    run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
    close: () => { throw new Error('The principal cannot close caller B.'); },
  });
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS n")).rows[0].n) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'true', CANVAS_MCP_DIRECT_SETTINGS_SOURCE: 'environment',
      CANVAS_MCP_DIRECT_TOOLS: 'read_knowledge_source,search_knowledge', CANVAS_MCP_DIRECT_TOOLS_SOURCE: 'environment',
      CANVAS_ORGANIZATION_ID: 'mcp-read-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const licenseClaims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'mcp-read-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(licenseClaims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No external issuer/network in this fixture.'); };
    stage = 'actual current-schema migration';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    const own = async () => assert.equal((await admin.query('SELECT current_schema() AS s')).rows[0].s, schema);
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real current user, read-only seat, workspace and OAuth grant';
    const now = Date.now(), workspaceId = `mcp-read-${crypto.randomUUID()}`, clientId = `client-${crypto.randomUUID()}`;
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@mcp-read.test',1,'admin',0,$1,$1),('reader','Reader','reader@mcp-read.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('mcp-read-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('mcp-read-org','owner','owner','active',1,100,100),('mcp-read-org','reader','member','active',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','mcp-read-org','owner@mcp-read.test','owner','owner','active',100,100,100,100),
      ('reader-seat','mcp-read-org','reader@mcp-read.test','reader','member','active',100,200,100,100)`);
    await admin.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('mcp-read-org',100,100)`);
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'mcp-read-org','organization','Read only','organizations/mcp-read-org/shared','active',100,100)`, [workspaceId]);
    await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('reader-session',$1,'reader',$2,$3,$3)`, [crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
    await admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
      VALUES('client-row',$1,'reader','Read client',0,'[]',100,100)`, [clientId]);
    await admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
      VALUES('consent-original',$1,'reader',$2,$3,100,100)`,
    [clientId, JSON.stringify(['knowledge:read', 'knowledge:search']), JSON.stringify(['http://localhost/mcp'])]);
    await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
      VALUES($1,'owner',100,100)`, [workspaceId]);
    await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
      VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    assert.equal((await getLicenseStatus()).edition, 'team'); assert.equal((await getLicenseStatus()).licensed, true);
    const { auth } = await import('../app/lib/auth');
    const { withDirectMcpDocumentReadPrincipal: capture, withDirectMcpDocumentReadPrincipalOnConnection: phase } =
      await import('../app/lib/mcp/server/document-read-principal');
    const { verifyDirectMcpAccessToken } = await import('../app/lib/mcp/server/access-token-verifier');
    const issuedAt = Math.floor(Date.now() / 1000) - 1;
    const issue = async (overrides: Record<string, unknown> = {}) => {
      const signed = await auth.api.signJWT({ body: { payload: { sub: 'reader', azp: clientId, sid: 'reader-session',
        iss: 'http://localhost/api/auth', aud: 'http://localhost/mcp', iat: issuedAt, exp: issuedAt + 600,
        scope: 'knowledge:read knowledge:search', ...overrides } } });
      assert(signed.token); return signed.token;
    };
    const token = await issue();
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken, clientId: 'untrusted-client', scopes: [], extra: { userId: 'owner' } });
    const transaction = async <T>(operation: (db: SqlConnection, client: Client) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE', assign = false): Promise<T> => {
      const client = await ownClient(); let began = false;
      try {
        await client.query(begin); began = true; if (assign) await client.query('SELECT pg_current_xact_id()');
        const result = await operation(connection(client), client); await client.query('COMMIT'); began = false; return result;
      } catch (error) {
        if (began) await client.query('ROLLBACK'); throw error;
      } finally { await endClient(client); }
    };
    const origins: DirectMcpDocumentReadHistoricalOrigin[] = [];
    const read = <T>(operation: (access: DirectMcpDocumentReadPrincipalAccess, client: Client) => Promise<T>, actualToken = token) =>
      capture(authInfo(actualToken), { workspaceId, purpose: 'read' }, origin => { origins.push(origin); },
        principal => transaction((db, client) => phase(db, principal, access => operation(access, client))));
    const code = (wanted: string) => (error: unknown) => {
      assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted); return true;
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`Direct MCP document read principal passed: ${name}`);
    };
    await check('genuine signed token, same B/XID and read-only workspace', async () => {
      // Exercise the existing own-checkout wrapper outside held B, including
      // its newly delegated unchanged SQL grant loader and actual seat check.
      const existing = await verifyDirectMcpAccessToken(token, ['knowledge:read']);
      assert.equal(existing.userId, 'reader'); assert.equal(existing.clientId, clientId); assert.equal(existing.sessionId, 'reader-session');
      await read(async (access, client) => {
        assert.equal(access.userId, 'reader'); assert.equal(access.clientId, clientId); assert.equal(access.sessionId, 'reader-session');
        assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.workspace.permissions.canWrite, false);
        assert(Object.isFrozen(access.workspace));
        const before = (await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        await access.assertCurrent();
        assert.deepEqual((await client.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0], before);
        assert(origins.length > 0); assert.equal(origins[0].schema, schema); assert(Object.isFrozen(origins[0]));
        assert(!Object.keys(origins[0]).some(key => /token|claims|payload/iu.test(key)));
      });
      assert(origins.length >= 3); for (const origin of origins) assert.deepEqual(origin, origins[0]);
      await capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(async (db, client) => {
          assert.equal((await client.query('SELECT pg_current_xact_id_if_assigned() AS xid')).rows[0].xid, null);
          await phase(db, principal, async () => {
            assert.match((await client.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, /^[1-9][0-9]*$/u);
          });
        }));
    });
    await check('fake scope fields cannot authorize missing read token scope', async () => {
      await assert.rejects(read(async () => undefined, await issue({ scope: 'knowledge:search' })), code('insufficient_scope'));
    });
    await check('search uses its own genuine scope without read or write', async () => {
      await capture(authInfo(await issue({ scope: 'knowledge:search' })), { workspaceId, purpose: 'search' }, () => undefined,
        principal => transaction(db => phase(db, principal, async access => { assert.equal(access.userId, 'reader'); })));
      await assert.rejects(capture(authInfo(await issue({ scope: 'knowledge:read' })), { workspaceId, purpose: 'search' }, () => undefined,
        principal => transaction(db => phase(db, principal, async () => undefined))), code('insufficient_scope'));
    });
    await check('wrong resource, invalid signature and inactive session fail closed', async () => {
      await assert.rejects(read(async () => undefined, await issue({ aud: 'http://localhost/api/documents' })), code('invalid_token'));
      const parts = token.split('.'); parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
      await assert.rejects(read(async () => undefined, parts.join('.')), code('invalid_token'));
      await assert.rejects(read(async () => undefined, await issue({ sid: 'absent' })), code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      await assert.rejects(read(async () => undefined, await issue({ exp: issuedAt - 1 })), code('invalid_token'));
    });
    await check('current token hash revocation', async () => {
      await admin.query(`INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
        VALUES($1,$2,'reader-session','reader',$3,$4)`, [crypto.createHash('sha256').update(token).digest('base64url'), clientId, now + 3600000, now]);
      try { await assert.rejects(read(async () => undefined), code('invalid_token')); }
      finally { await admin.query('DELETE FROM mcp_revoked_access_token'); }
    });
    await check('current grant revocation and latest consent', async () => {
      await admin.query(`INSERT INTO mcp_direct_grant_revocation(client_id,session_id,user_id,revoked_at) VALUES($1,'reader-session','reader',$2)`, [clientId, now]);
      try { await assert.rejects(read(async () => undefined), code('invalid_token')); }
      finally { await admin.query('DELETE FROM mcp_direct_grant_revocation'); }
      await admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,created_at,updated_at) VALUES('latest',$1,'reader','[]',$2,$2)`, [clientId, now]);
      try { await assert.rejects(read(async () => undefined), code('invalid_token')); }
      finally { await admin.query("DELETE FROM oauth_consent WHERE id='latest'"); }
    });
    await check('banned account, disabled client and seat removal', async () => {
      for (const [alter, restore] of [
        ['UPDATE "user" SET banned=1 WHERE id=\'reader\'', 'UPDATE "user" SET banned=0 WHERE id=\'reader\''],
        ['UPDATE "user" SET banned=2 WHERE id=\'reader\'', 'UPDATE "user" SET banned=0 WHERE id=\'reader\''],
        ['UPDATE oauth_client SET disabled=1', 'UPDATE oauth_client SET disabled=0'],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
      ]) {
        await admin.query(alter);
        try { await assert.rejects(read(async () => undefined)); }
        finally { await admin.query(restore); }
      }
    });
    await check('workspace opt-in and client grant independently required', async () => {
      await admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1', [clientId]);
      try { await assert.rejects(read(async () => undefined), code('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
      finally { await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]); }
      await admin.query('DELETE FROM mcp_direct_workspace_setting WHERE workspace_id=$1', [workspaceId]);
      try { await assert.rejects(read(async () => undefined), code('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
      finally { await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,'owner',100,100)`, [workspaceId]); }
    });
    await check('fresh runtime enabled and purpose tool checked at callback exit', async () => {
      for (const field of ['CANVAS_MCP_DIRECT_ENABLED', 'CANVAS_MCP_DIRECT_TOOLS']) {
        const original = process.env[field];
        try { await assert.rejects(read(async () => { process.env[field] = field.endsWith('ENABLED') ? 'false' : 'search_knowledge'; }), code('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
        finally { process.env[field] = original; }
      }
    });
    await check('final session, workspace grant and opt-in rechecks on same B', async () => {
      for (const sql of ["UPDATE \"session\" SET expires_at=1 WHERE id='reader-session'",
        'DELETE FROM mcp_direct_workspace_grant', 'DELETE FROM mcp_direct_workspace_setting']) {
        await assert.rejects(read(async (_access, client) => { await client.query(sql); }));
        // Caller rollback restored every counterfixture.
        await read(async () => undefined);
      }
    });
    await check('table SHARE fences exclude phantom revocation/consent/grant writers', async () => {
      const peer = await ownClient();
      try {
        await read(async () => {
          for (const [sql, values] of [
            [`INSERT INTO mcp_direct_grant_revocation(client_id,session_id,user_id,revoked_at) VALUES($1,'reader-session','reader',$2)`, [clientId, now]],
            [`INSERT INTO oauth_consent(id,client_id,user_id,scopes,created_at,updated_at) VALUES('phantom',$1,'reader','[]',$2,$2)`, [clientId, now]],
            ['DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1', [clientId]],
          ] as const) {
            await assert.rejects(peer.query(sql, [...values]), code('55P03'));
          }
        });
      } finally { await endClient(peer); }
    });
    await check('writer in progress yields busy before consumer', async () => {
      const peer = await ownClient(); let entered = false;
      try {
        await peer.query('BEGIN'); await peer.query('LOCK TABLE mcp_direct_grant_revocation IN ROW EXCLUSIVE MODE');
        await assert.rejects(read(async () => { entered = true; }), code('MCP_READ_PRINCIPAL_BUSY')); assert.equal(entered, false);
      } finally { await peer.query('ROLLBACK'); await endClient(peer); }
    });
    await check('RC/RW, assigned XID, original namespace and stable transaction required', async () => {
      for (const [begin, assign] of [['BEGIN ISOLATION LEVEL REPEATABLE READ', false], ['BEGIN READ ONLY', false]] as const) {
        await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
          principal => transaction(db => phase(db, principal, async () => undefined), begin, assign)), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(read(async (_access, client) => { await client.query('COMMIT'); await client.query('BEGIN'); await client.query('SELECT pg_current_xact_id()'); }), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(read(async (_access, client) => { await client.query('SET LOCAL search_path=pg_catalog'); }), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('same-name temp relation cannot shadow original auth tables', async () => {
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(async (db, client) => {
          await client.query('CREATE TEMP TABLE mcp_direct_workspace_grant(client_id text)');
          return phase(db, principal, async () => undefined);
        })), code('MCP_READ_PRINCIPAL_SCHEMA_INVALID'));
    });
    await check('principal forgery, expired access and descriptor inputs', async () => {
      await assert.rejects(transaction(db => phase(db, Object.freeze({}) as DirectMcpDocumentReadPrincipal, async () => undefined)), code('MCP_READ_PRINCIPAL_REQUIRED'));
      let escaped: DirectMcpDocumentReadPrincipalAccess | undefined;
      await read(async access => { escaped = access; }); assert(escaped);
      await assert.rejects(escaped.assertCurrent(), code('MCP_READ_PRINCIPAL_REQUIRED'));
      let getters = 0;
      await assert.rejects(capture(Object.defineProperty({}, 'token', { enumerable: true, get: () => { getters++; return token; } }) as AuthInfo,
        { workspaceId, purpose: 'read' }, () => undefined, async () => undefined), code('MCP_READ_PRINCIPAL_INVALID'));
      assert.equal(getters, 0);
    });
    await check('reentrancy and swallowed current failure poison the principal', async () => {
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(db => phase(db, principal, async () => {
          await assert.rejects(phase(db, Object.freeze({}) as DirectMcpDocumentReadPrincipal, async () => undefined), code('MCP_READ_PRINCIPAL_REQUIRED'));
        }))), code('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(db => phase(db, principal, async () => {
          await assert.rejects(phase(db, principal, async () => undefined), code('MCP_READ_PRINCIPAL_REENTRANT'));
        }))), code('MCP_READ_PRINCIPAL_REENTRANT'));
      await assert.rejects(read(async (access, client) => {
        await client.query('DELETE FROM mcp_direct_workspace_grant');
        await assert.rejects(access.assertCurrent(), code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      }), code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
    });
    await check('oversized actual user fields are rejected before transport and retained', async () => {
      for (const [column, restore] of [['email', 'reader@mcp-read.test'], ['role', 'user']] as const) {
        await admin.query(`UPDATE "user" SET ${column}=repeat('x',8192) WHERE id='reader'`);
        try {
          await assert.rejects(read(async () => undefined), code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
          assert.equal((await admin.query(`SELECT octet_length(${column}) AS bytes FROM "user" WHERE id='reader'`)).rows[0].bytes, 8192);
        } finally { await admin.query(`UPDATE "user" SET ${column}=$1 WHERE id='reader'`, [restore]); }
      }
    });
    await check('actual MCP service reads native body and UTF8 continuation pages with fresh current authority', async () => {
      const { readDocumentForDirectMcp } = await import('../app/lib/documents/service');
      const { DocumentReadError } = await import('../app/lib/documents/contracts');
      const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
      const { Y } = await import('../app/lib/collaboration/server-runtime');
      const { collaborationStateProof } = await import('../app/lib/collaboration/state-proof');
      const { documentVersionV1 } = await import('../app/lib/documents/read-version');
      const { isLiveCollaborationDocumentReaderAvailable } = await import('../app/lib/collaboration/document-access');
      assert.equal(isLiveCollaborationDocumentReaderAvailable(), false);
      const documentId = `document-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      const filePath = `actual-native-${crypto.randomUUID()}.md`, text = 'A😀B🧪C';
      const doc = createPlainTextYDoc(text);
      const { bytes, vector, proof } = (() => {
        try {
          const stateProof = collaborationStateProof(doc, Y); assert(stateProof);
          return { bytes: Buffer.from(Y.encodeStateAsUpdate(doc)), vector: Buffer.from(Y.encodeStateVector(doc)), proof: stateProof };
        } finally { doc.destroy(); }
      })();
      // These genuine D/L/S SQL rows are private counterfixture construction,
      // never evidence of public create/write or a manufactured principal.
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','mcp-read-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','mcp-read-org',$4,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'mcp-read-org',$3,'plain_text',1,1,$4,$5,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`,
      [documentId, workspaceId, filePath, bytes, vector]);
      await admin.query(`INSERT INTO workspace_file_metadata(workspace_id,path,title,created_at,updated_at) VALUES($1,$2,'Native read title',100,100)`, [workspaceId, filePath]);
      const stored = async () => ({
        document: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_documents WHERE id=$1', [documentId])).rows,
        lineage: (await admin.query('SELECT *,xmin::text AS original_xmin FROM file_collaboration_lineages WHERE id=$1', [lineageId])).rows,
        state: (await admin.query('SELECT *,xmin::text AS original_xmin FROM collaboration_yjs_states WHERE document_id=$1', [documentId])).rows,
        metadata: (await admin.query('SELECT *,xmin::text AS original_xmin FROM workspace_file_metadata WHERE workspace_id=$1 AND path=$2', [workspaceId, filePath])).rows,
      });
      const before = await stored();
      const expectedIdentity = { workspaceId, organizationId: 'mcp-read-org', documentId, lineageId,
        lifecycleGeneration: 1, representation: 'plain_text' as const, schemaVersion: 1 };
      const expectedVersion = documentVersionV1(expectedIdentity, proof);
      const native = await readDocumentForDirectMcp(authInfo(), { apiVersion: 1, workspaceId, documentId, format: 'native', maxBytes: 256 });
      assert.equal(native.complete, true); assert.equal(native.nextCursor, null);
      assert.equal(native.mediaType, 'application/vnd.canvas.native-document+json');
      assert.deepEqual(JSON.parse(native.fragment), { bodyVersion: 1, representation: 'plain_text', content: { kind: 'plain_text', text } });
      assert.equal(native.document.version, expectedVersion); assert.equal(native.document.title, 'Native read title');
      assert.equal(native.document.path, filePath); assert.equal(native.document.lineageId, lineageId);
      assert.equal(native.currency.source, 'persisted_yjs'); assert.equal(native.currency.observedDurable, true);
      assert.equal(native.currency.durableSequence, 7); assert.equal(native.projection.status, 'pending');
      const pages: Awaited<ReturnType<typeof readDocumentForDirectMcp>>[] = [];
      let cursor: string | undefined, byteOffset = 0, fullText = '';
      // Every invocation enters the actual service's new B checkout/TX, genuine
      // token/current phase and COMMIT/disposal. No transport/SQL result stub.
      for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
        const page = await readDocumentForDirectMcp(authInfo(), { apiVersion: 1, workspaceId, documentId,
          format: 'text', maxBytes: 4, expectedVersion, ...(cursor === undefined ? {} : { cursor }) });
        assert.deepEqual(page.document, native.document); assert.deepEqual(page.currency, native.currency);
        assert.equal(page.byteOffset, byteOffset); assert.equal(page.byteLength, Buffer.byteLength(page.fragment, 'utf8'));
        assert(page.byteLength > 0 && page.byteLength <= 4); assert.equal(page.totalBytes, Buffer.byteLength(text, 'utf8'));
        assert.equal(page.mediaType, 'text/plain'); assert.equal(page.fragment.includes('\ufffd'), false);
        fullText += page.fragment; byteOffset += page.byteLength; pages.push(page);
        if (page.complete) { assert.equal(page.nextCursor, null); break; }
        assert.equal(typeof page.nextCursor, 'string'); cursor = page.nextCursor!;
      }
      assert.equal(pages.length, 5); assert.equal(pages.at(-1)!.complete, true); assert.equal(fullText, text);
      assert.equal(byteOffset, Buffer.byteLength(text, 'utf8'));
      await assert.rejects(readDocumentForDirectMcp(authInfo(await issue({ scope: 'knowledge:search' })),
        { apiVersion: 1, workspaceId, documentId }), error => {
        assert.equal(Reflect.get(error as object, 'status'), 403); return code('insufficient_scope')(error);
      });
      await admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1', [clientId]);
      try {
        await assert.rejects(readDocumentForDirectMcp(authInfo(), { apiVersion: 1, workspaceId, documentId }), error => {
          assert(error instanceof DocumentReadError); assert.equal(error.status, 403); return code('ACCESS_DENIED')(error);
        });
      } finally {
        await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]);
      }
      assert.deepEqual(await stored(), before);
    });
    await check('actual backend and schema OID drift and original factory search path are rejected', async () => {
      let calls = 0;
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(async (db, client) => {
          await client.query(`SET LOCAL search_path=${schema},pg_catalog,public`);
          return phase(db, principal, async () => { calls++; });
        })), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      assert.equal(calls, 0);
      const originalOid = (await admin.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid;
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(async (db, client) => {
          try {
            return await phase(db, principal, async () => {
              const renamed = `mcp_read_old_${crypto.randomUUID().replaceAll('-', '')}`;
              await client.query(`ALTER SCHEMA "${schema}" RENAME TO "${renamed}"`);
              await client.query(`CREATE SCHEMA "${schema}"`);
              assert.notEqual((await client.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid, originalOid);
            });
          } finally {
            // Roll back owned diagnostic DDL even if a broken guard returned.
            await client.query('ROLLBACK'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
          }
        })), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      assert.equal((await admin.query('SELECT to_regnamespace($1)::oid::text AS oid', [schema])).rows[0].oid, originalOid);
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(async (_db, client) => {
          const peer = await ownClient(); let selected = client;
          const actual: SqlConnection = {
            get: async (sql, values) => (await selected.query(sql, values)).rows[0],
            all: async (sql, values) => (await selected.query(sql, values)).rows,
            run: async (sql, values) => ({ changes: (await selected.query(sql, values)).rowCount ?? 0 }),
            close: () => assert.fail('No principal disposal authority.'),
          };
          try {
            await peer.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
            return await phase(actual, principal, async () => {
              assert.notEqual((await peer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
                (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
              selected = peer;
            });
          } finally { await peer.query('ROLLBACK'); await endClient(peer); }
        })), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
    });
    await check('async observer and detached current assertion cannot publish a principal result', async () => {
      let calls = 0;
      await assert.rejects(capture(authInfo(), { workspaceId, purpose: 'read' }, async () => undefined,
        principal => transaction(db => phase(db, principal, async () => { calls++; }))), code('MCP_READ_PRINCIPAL_DETACHED'));
      assert.equal(calls, 0);
      await assert.rejects(read(async access => { void access.assertCurrent().catch(() => undefined); }), code('MCP_READ_PRINCIPAL_DETACHED'));
    });
    assert.equal(cases, 20); assert.equal(fetches, 0);
  } finally {
    stage = `cleanup after ${stage}`;
    try { if (pool) await pool.end(); }
    finally {
      try { for (const client of clients) await client.end(); clients.clear(); }
      finally {
        try {
          if (created) {
            assert.match(schema, /^mcp_document_read_[a-f0-9]{32}$/u); await control.query(`DROP SCHEMA "${schema}" CASCADE`);
            assert.equal((await control.query('SELECT to_regnamespace($1) AS oid', [schema])).rows[0].oid, null);
          }
        } finally {
          try { await control.end(); } finally {
            await rm(dataRoot, { recursive: true }); globalThis.fetch = originalFetch;
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
            Object.assign(process.env, environment);
          }
        }
      }
    }
  }
  console.log(JSON.stringify({ suite: 'direct-mcp-document-read-principal', groups: cases, passed: true, fetches,
    cleanup: { schemaRemoved: true, clientsClosed: clients.size === 0, dataRemoved: true } }));
}
main().catch(error => {
  console.error('Direct MCP document read principal fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    constraint: error && typeof error === 'object' ? Reflect.get(error, 'constraint') ?? null : null });
  process.exitCode = 1;
});
