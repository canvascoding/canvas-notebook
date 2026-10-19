import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { DirectMcpWorkspaceCopyPrincipal, DirectMcpWorkspaceCopyPrincipalAccess,
  DirectMcpDocumentReadPrincipal } from '../app/lib/mcp/server/document-read-principal';
import type { WorkspaceOperationCopyMcpOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Real signed fixture JWTs, current grants, actual workspace constructors and
// caller-owned PG transactions. No authority, verifier, SQL-result, permission
// or clock substitutes. The reserved tool has no public Copy handler yet.
let currentCase = 'setup', passed = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const expectedCode = (wanted: string) => (error: unknown): boolean => {
  assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted); return true;
};
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}

export async function directMcpWorkspaceCopyPrincipalPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, clientId } = fixture;
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const { withDirectMcpWorkspaceCopyPrincipal: capture, withDirectMcpWorkspaceCopyPrincipalOnConnection: phase,
      assertDirectMcpWorkspaceCopyPrincipalCaptured: preflight,
      withDirectMcpDocumentReadPrincipal: captureRead, withDirectMcpDocumentReadPrincipalOnConnection: readPhase } =
      await import('../app/lib/mcp/server/document-read-principal');
    const { withWorkspaceCopyMcpOnConnection: domainPhase } = await import('../app/lib/workspaces/copy-principal');
    const { captureWorkspaceOperationCopyMcpOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    const { createPostgresWorkspaceForActor, upsertPostgresWorkspaceMemberForActor } =
      await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@dispatch.test' });
    const source = await createPostgresWorkspaceForActor(owner, { type: 'team', name: 'MCP Copy read source' });
    const destination = await createPostgresWorkspaceForActor(owner, { type: 'team', name: 'MCP Copy write destination' });
    await upsertPostgresWorkspaceMemberForActor(owner, source.workspaceId,
      { userId: 'reader', canRead: true, canWrite: false, canManage: false });
    await upsertPostgresWorkspaceMemberForActor(owner, destination.workspaceId,
      { userId: 'reader', canRead: true, canWrite: true, canManage: false });
    const sourceWorkspaceId = source.workspaceId, destinationWorkspaceId = destination.workspaceId;
    const selection = Object.freeze({ sourceWorkspaceId, destinationWorkspaceId });
    const tools = 'read_knowledge_source,search_knowledge,create_knowledge_source,edit_knowledge_source,copy_knowledge_source';
    process.env.CANVAS_MCP_DIRECT_TOOLS = tools;
    await admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id=$3',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId, 'reader']);
    for (const workspaceId of [sourceWorkspaceId, destinationWorkspaceId]) {
      await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
        VALUES($1,'owner',100,100)`, [workspaceId]);
      await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
        VALUES($1,'reader',$2,100,100)`, [clientId, workspaceId]);
    }
    await admin.query('CREATE TABLE copy_mcp_principal_writes(id text PRIMARY KEY,backend integer NOT NULL,xid text NOT NULL)');
    const domainBefore = await fixture.snapshot(), token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken,
      clientId: 'untrusted-client-dto', scopes: ['knowledge:write'], extra: { userId: 'owner' } });
    // All operations reach the genuine PG client; the adapter merely borrows B.
    const transaction = async <T>(operation: (db: SqlConnection, client: PoolClient, sql: string[]) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'): Promise<T> => {
      const client = await pool.connect(), sql: string[] = []; let began = false, discard: Error | undefined;
      const query = async (statement: string, values?: unknown[]) => {
        assert(!/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu.test(statement),
          'A borrowed Copy principal must not control caller B.');
        sql.push(statement); return client.query(statement, values);
      };
      const db: SqlConnection = { get: async (s, v) => (await query(s, v)).rows[0],
        all: async (s, v) => (await query(s, v)).rows, run: async (s, v) => ({ changes: (await query(s, v)).rowCount ?? 0 }),
        close: () => assert.fail('A borrowed Copy principal must not close caller B.') };
      try {
        await client.query(begin); began = true;
        const value = await operation(db, client, sql); await client.query('COMMIT'); began = false; return value;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollbackError) { discard = new AggregateError([error, rollbackError], 'Actual Copy-test B rollback failed.'); throw discard; }
        throw error;
      } finally { client.release(discard); }
    };
    const copy = <T>(operation: (access: DirectMcpWorkspaceCopyPrincipalAccess, db: SqlConnection,
      client: PoolClient, sql: string[]) => Promise<T>, actualToken = token,
      selected = selection): Promise<T> => capture(authInfo(actualToken), selected,
      principal => transaction((db, client, sql) => phase(db, principal, access => operation(access, db, client, sql))));
    const check = async (name: string, action: () => Promise<void>): Promise<void> => {
      currentCase = name; await action(); passed++; console.log(`PASS MCP Copy principal: ${name}`);
    };
    const facts = async (client: PoolClient) => (await client.query(`SELECT pg_backend_pid() AS pid,
      pg_current_xact_id()::text AS xid,current_schema() AS schema,current_setting('search_path') AS search_path,
      current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout,
      current_setting('transaction_timeout') AS transaction_timeout`)).rows[0];
    const witness = async (db: SqlConnection, id: string) => {
      await db.run('INSERT INTO copy_mcp_principal_writes SELECT $1,pg_backend_pid(),pg_current_xact_id()::text', [id]);
      const row = object(await db.get('SELECT backend,xid,xmin::text AS xmin FROM copy_mcp_principal_writes WHERE id=$1', [id]));
      assert.equal(row.xmin, (BigInt(String(row.xid)) % BigInt('4294967296')).toString()); return row;
    };
    const absent = async (id: string) => assert.equal((await admin.query(
      'SELECT count(*)::integer AS count FROM copy_mcp_principal_writes WHERE id=$1', [id])).rows[0].count, 0);

    await check('source READ and destination WRITE share one genuine B and one bounded phase', async () => {
      const sourceRealm = (await pool.query("SELECT current_schema() AS schema,current_setting('search_path') AS search_path")).rows[0];
      const canonicalRealm = (await pool.query("SELECT current_schema() AS schema,pg_catalog.quote_ident(current_schema())||', pg_catalog, pg_temp' AS search_path")).rows[0];
      const result = await copy(async (access, db, client, sql) => {
        assert.equal(access.tool, 'copy_knowledge_source'); assert.equal(access.userId, 'reader');
        assert.equal(access.clientId, clientId); assert.equal(access.sessionId, 'reader-session');
        assert.equal(access.sourceWorkspace.workspaceId, sourceWorkspaceId);
        assert.equal(access.destinationWorkspace.workspaceId, destinationWorkspaceId);
        assert.deepEqual([access.sourceWorkspace.permissions.canRead, access.sourceWorkspace.permissions.canWrite], [true, false]);
        assert.deepEqual([access.destinationWorkspace.permissions.canRead, access.destinationWorkspace.permissions.canWrite,
          access.destinationWorkspace.permissions.canRunAgent], [true, true, true]);
        for (const value of [access, access.sourceWorkspace, access.sourceWorkspace.permissions,
          access.destinationWorkspace, access.destinationWorkspace.permissions]) assert(Object.isFrozen(value));
        const before = await facts(client); assert.deepEqual({ schema: before.schema, search_path: before.search_path }, canonicalRealm);
        assert.equal(before.lock_timeout, '50ms'); assert.equal(before.statement_timeout, '5s'); assert.equal(before.transaction_timeout, '5s');
        const row = await witness(db, 'committed'); assert.equal(row.backend, before.pid); assert.equal(row.xid, before.xid);
        await access.assertCurrent(); assert.deepEqual(await facts(client), before);
        assert.equal(sql.filter(s => /^SET LOCAL statement_timeout\s*=/iu.test(s)).length, 1,
          'Source and destination must not each reset a separate five-second B phase.');
        return 'same-actual-B';
      });
      assert.equal(result, 'same-actual-B');
      assert.deepEqual((await pool.query("SELECT current_schema() AS schema,current_setting('search_path') AS search_path")).rows[0], sourceRealm,
        'Copy execution realm must not change the original factory realm after COMMIT.');
      assert.equal((await admin.query('SELECT count(*)::integer AS count FROM copy_mcp_principal_writes WHERE id=$1', ['committed'])).rows[0].count, 1);
      await copy(async access => {
        assert.equal(access.sourceWorkspace.workspaceId, destinationWorkspaceId);
        assert.equal(access.destinationWorkspace.workspaceId, destinationWorkspaceId);
        assert.equal(access.destinationWorkspace.permissions.canWrite, true); await access.assertCurrent();
      }, token, { sourceWorkspaceId: destinationWorkspaceId, destinationWorkspaceId });
      await assert.rejects(copy(async () => assert.fail('Same-workspace Copy still needs destination Write.'), token,
        { sourceWorkspaceId, destinationWorkspaceId: sourceWorkspaceId }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
    });

    await check('Write scope and exact explicit tool selection advertise the connected strict Copy handler', async () => {
      for (const scope of ['knowledge:read', 'knowledge:search']) {
        await assert.rejects(copy(async () => assert.fail('Read/Search is not Copy Write.'), await fixture.issue({ scope })),
          expectedCode('insufficient_scope'));
      }
      process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,create_knowledge_source,edit_knowledge_source';
      try { await assert.rejects(copy(async () => assert.fail('Other write tools do not enable Copy.')),
        expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
      finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; }
      await copy(async access => { await access.assertCurrent(); }, await fixture.issue({ scope: 'knowledge:write' }));
      const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
      const { DIRECT_MCP_PROTOCOL_VERSION: protocol, DIRECT_MCP_DEFAULT_TOOL_IDS, DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS,
        DIRECT_MCP_TOOL_CONFIGURATION_VERSION } = await import('../app/lib/mcp/server/config');
      assert.equal(DIRECT_MCP_TOOL_CONFIGURATION_VERSION, 7);
      assert.equal((DIRECT_MCP_DEFAULT_TOOL_IDS as readonly string[]).includes('copy_knowledge_source'), false);
      assert((DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS as readonly string[]).includes('copy_knowledge_source'));
      let id = 0;
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const requestId = ++id;
        const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
          'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': 'copy_knowledge_source' } : {}), authorization: `Bearer ${token}`,
        }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientInfo': { name: 'copy-principal-fixture', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } }) }));
        assert.equal(response.status, 200); const body = object(await response.json());
        assert.equal(body.id, requestId); assert.equal(body.jsonrpc, '2.0'); return body;
      };
      const before = await fixture.snapshot(), listed = object((await rpc('tools/list', {})).result);
      assert(Array.isArray(listed.tools)); assert(listed.tools.length > 0);
      assert.equal(listed.tools.some(tool => object(tool).name === 'copy_knowledge_source'), true);
      const called = await rpc('tools/call', { name: 'copy_knowledge_source', arguments: {
        source_workspace_id: sourceWorkspaceId, destination_workspace_id: destinationWorkspaceId, path: 'never-created.md',
      } });
      assert.equal(Object.hasOwn(called, 'error'), false);
      const rejected = object(called.result); assert.equal(rejected.isError, true);
      assert.equal(object(rejected.structuredContent).code, 'INVALID_REQUEST');
      assert.deepEqual(await fixture.snapshot(), before);
    });

    await check('each workspace needs its own actual opt-in, client grant and current ACL', async () => {
      for (const workspaceId of [sourceWorkspaceId, destinationWorkspaceId]) {
        for (const relation of ['mcp_direct_workspace_setting', 'mcp_direct_workspace_grant'] as const) {
          const rows = (await admin.query(`DELETE FROM ${relation} WHERE workspace_id=$1 RETURNING *`, [workspaceId])).rows;
          assert.equal(rows.length, 1); let consumers = 0;
          try { await assert.rejects(copy(async () => { consumers++; }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
          finally {
            if (relation === 'mcp_direct_workspace_setting') await admin.query(`INSERT INTO mcp_direct_workspace_setting
              (workspace_id,enabled_by_user_id,enabled_at,updated_at) VALUES($1,$2,$3,$4)`,
            [rows[0].workspace_id, rows[0].enabled_by_user_id, rows[0].enabled_at, rows[0].updated_at]);
            else await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5)`, [rows[0].client_id, rows[0].user_id, rows[0].workspace_id, rows[0].created_at, rows[0].updated_at]);
          }
          assert.equal(consumers, 0);
        }
      }
      for (const [workspaceId, column] of [[sourceWorkspaceId, 'can_read'], [destinationWorkspaceId, 'can_write']] as const) {
        const result = await admin.query(`UPDATE canvas_workspace_members SET ${column}=0 WHERE workspace_id=$1 AND user_id='reader'`, [workspaceId]);
        assert.equal(result.rowCount, 1); let consumers = 0;
        try { await assert.rejects(copy(async () => { consumers++; }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
        finally { await admin.query(`UPDATE canvas_workspace_members SET ${column}=1 WHERE workspace_id=$1 AND user_id='reader'`, [workspaceId]); }
        assert.equal(consumers, 0);
      }
      await copy(async access => { await access.assertCurrent(); });
    });

    await check('caller controls rollback while realm, XID and auth-table identity stay pinned', async () => {
      const callerFailure = new Error('Owned caller rollback witness.');
      await assert.rejects(copy(async (_access, db) => { await witness(db, 'caller-rollback'); throw callerFailure; }), error => error === callerFailure);
      await absent('caller-rollback');
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN READ ONLY']) {
        await assert.rejects(capture(authInfo(), selection, principal => transaction(db => phase(db, principal,
          async () => assert.fail('Wrong transaction cannot enter.')), begin)), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(copy(async (_access, _db, client) => {
        await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await client.query('SELECT pg_current_xact_id()');
      }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(copy(async (_access, db) => { await db.run('SET LOCAL search_path=pg_catalog'); }),
        expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(authInfo(), selection, principal => transaction(async (db, client) => {
        await client.query('CREATE TEMP TABLE mcp_direct_workspace_grant(client_id text)');
        return phase(db, principal, async () => assert.fail('A temporary auth-table shadow cannot enter.'));
      })), expectedCode('MCP_READ_PRINCIPAL_SCHEMA_INVALID'));
    });

    await check('within-B source, destination, client and session revocations poison swallowed checks', async () => {
      const mutations: ReadonlyArray<{ sql: string; values?: unknown[]; code: string }> = [
        { sql: "UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id='reader'", values: [sourceWorkspaceId], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
        { sql: "UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id='reader'", values: [destinationWorkspaceId], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
        ...[sourceWorkspaceId, destinationWorkspaceId].map(workspaceId => ({ sql: 'DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2', values: [workspaceId, clientId], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' })),
        { sql: 'UPDATE oauth_client SET disabled=1 WHERE client_id=$1', values: [clientId], code: 'invalid_token' },
        { sql: "UPDATE \"session\" SET expires_at=1 WHERE id='reader-session'", code: 'invalid_token' },
        { sql: `INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
            VALUES($1,$2,'reader-session','reader',$3,$4)`, values: [crypto.createHash('sha256').update(token).digest('base64url'), clientId, Date.now() + 600000, Date.now()], code: 'invalid_token' },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const id = `revoked-${index}`; let consumed = false;
        await assert.rejects(copy(async (access, db) => {
          consumed = true; await witness(db, id); assert.equal(object(await db.run(mutation.sql, mutation.values)).changes, 1);
          await assert.rejects(access.assertCurrent(), expectedCode(mutation.code)); // Deliberately swallowed.
        }), expectedCode(mutation.code));
        assert.equal(consumed, true); await absent(id); await copy(async access => { await access.assertCurrent(); });
      }
      // The principal must also reject at its own final destination->source
      // checks when the consumer never calls assertCurrent at all.
      for (const [index, mutation] of mutations.slice(0, 2).entries()) {
        const id = `final-slot-${index}`;
        await assert.rejects(copy(async (_access, db) => {
          await witness(db, id); assert.equal(object(await db.run(mutation.sql, mutation.values)).changes, 1);
        }), expectedCode(mutation.code)); await absent(id);
      }
      try {
        await assert.rejects(copy(async (access, db) => {
          await witness(db, 'tool-disabled'); process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,edit_knowledge_source';
          await assert.rejects(access.assertCurrent(), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); await absent('tool-disabled');
      } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; }
    });

    await check('renewed genuine SID B retains Original A while foreign client and user cannot borrow it', async () => {
      let originalA: WorkspaceOperationCopyMcpOrigin | undefined;
      await copy(async access => { originalA = captureWorkspaceOperationCopyMcpOrigin({ userId: access.userId,
        clientId: access.clientId, sessionId: access.sessionId, sourceWorkspace: access.sourceWorkspace,
        destinationWorkspace: access.destinationWorkspace }); });
      assert(originalA); const original = originalA, originalBytes = JSON.stringify(original);
      const sessionB = `copy-session-${crypto.randomUUID()}`, now = Date.now();
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'reader',$3,$4,$4)`, [sessionB, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const tokenB = await fixture.issue({ sid: sessionB, scope: 'knowledge:write' });
      await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
      try {
        await capture(authInfo(tokenB), selection, principal => transaction(db => domainPhase(db, principal, original, async current => {
          assert.equal(current.currentActor.userId, 'reader'); assert.equal(current.currentActor.sessionId, sessionB);
          assert.equal(current.originalOrigin.version, 2); assert.equal(current.originalOrigin.actor.sessionId, 'reader-session');
          assert.deepEqual(current.originalOrigin, original); assert(Object.isFrozen(current.originalOrigin));
          assert.equal(JSON.stringify(original), originalBytes); assert.notEqual(current.currentActor.sessionId, current.originalOrigin.actor.sessionId);
        })));
        await assert.rejects(copy(async () => assert.fail('The original expired session is no longer authority.')),
          expectedCode('invalid_token'));
      } finally { await fixture.restoreReaderSession(); }
      const otherClient = `copy-foreign-${crypto.randomUUID()}`, ownerSession = `copy-owner-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO oauth_client(id,client_id,user_id,name,disabled,redirect_uris,created_at,updated_at)
        VALUES($1,$1,'reader','Owned second client',0,'[]',100,100)`, [otherClient]);
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'owner',$3,$4,$4)`, [ownerSession, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      try {
        for (const [actualClient, userId] of [[otherClient, 'reader'], [clientId, 'owner']] as const) {
          await admin.query(`INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
            VALUES($1,$2,$3,'["knowledge:write"]','["http://localhost/mcp"]',100,100)`, [crypto.randomUUID(), actualClient, userId]);
          for (const workspaceId of [sourceWorkspaceId, destinationWorkspaceId]) await admin.query(`INSERT INTO mcp_direct_workspace_grant
            (client_id,user_id,workspace_id,created_at,updated_at) VALUES($1,$2,$3,100,100)`, [actualClient, userId, workspaceId]);
          const foreign = await fixture.issue({ azp: actualClient, sub: userId,
            sid: userId === 'reader' ? 'reader-session' : ownerSession, scope: 'knowledge:write' });
          // First prove genuine current authority; only historical Origin A differs.
          await copy(async access => { assert.equal(access.userId, userId); assert.equal(access.clientId, actualClient); }, foreign);
          let entered = false;
          await assert.rejects(capture(authInfo(foreign), selection, principal => transaction(db => domainPhase(db, principal, original,
            async () => { entered = true; }))), expectedCode('COPY_ORIGIN_CHANGED'));
          assert.equal(entered, false); assert.equal(JSON.stringify(original), originalBytes);
        }
      } finally {
        await admin.query('DELETE FROM mcp_direct_workspace_grant WHERE client_id=$1 OR user_id=$2', [otherClient, 'owner']);
        await admin.query('DELETE FROM oauth_consent WHERE client_id=$1 OR user_id=$2', [otherClient, 'owner']);
        await admin.query('DELETE FROM oauth_client WHERE client_id=$1', [otherClient]);
        await admin.query('DELETE FROM "session" WHERE id=ANY($1::text[])', [[sessionB, ownerSession]]);
      }
      let scopeConsumer = false;
      await assert.rejects(capture(authInfo(), { sourceWorkspaceId: destinationWorkspaceId, destinationWorkspaceId },
        principal => transaction(db => domainPhase(db, principal, original, async () => { scopeConsumer = true; }))),
      expectedCode('COPY_ORIGIN_CHANGED'));
      assert.equal(scopeConsumer, false);
      assert.equal(JSON.stringify(original), originalBytes);
    });

    await check('caller options and bearer are detached synchronously and hostile selectors execute no traps', async () => {
      const mutable = { ...selection }, caller = authInfo();
      const captured = capture(caller, mutable, principal => transaction(db => phase(db, principal, async access => {
        assert.equal(access.sourceWorkspace.workspaceId, sourceWorkspaceId); assert.equal(access.destinationWorkspace.workspaceId, destinationWorkspaceId);
        assert.equal(access.sessionId, 'reader-session'); assert.equal(access.clientId, clientId);
      })));
      mutable.sourceWorkspaceId = destinationWorkspaceId; mutable.destinationWorkspaceId = sourceWorkspaceId;
      caller.token = 'caller-mutated-after-capture'; await captured;
      let traps = 0;
      const handler: ProxyHandler<object> = { get() { traps++; throw new Error('Unexpected proxy get.'); },
        ownKeys() { traps++; throw new Error('Unexpected proxy keys.'); }, getPrototypeOf() { traps++; throw new Error('Unexpected proxy prototype.'); },
        getOwnPropertyDescriptor() { traps++; throw new Error('Unexpected proxy descriptor.'); } };
      const revoked = Proxy.revocable({ ...selection }, handler); revoked.revoke();
      const getter = Object.defineProperty({ destinationWorkspaceId }, 'sourceWorkspaceId', {
        enumerable: true, get() { traps++; return sourceWorkspaceId; } });
      for (const bad of [new Proxy({ ...selection }, handler), revoked.proxy, getter]) {
        await assert.rejects(capture(authInfo(), bad as typeof selection, async () => assert.fail('Hostile selector cannot create a handle.')),
          expectedCode('MCP_READ_PRINCIPAL_INVALID')); assert.equal(traps, 0);
      }
    });

    await check('forged, wrong-brand, escaped, reentrant and detached handles never grant Copy', async () => {
      await assert.rejects(transaction(db => phase(db, Object.freeze({}) as DirectMcpWorkspaceCopyPrincipal,
        async () => assert.fail('A DTO is not a principal.'))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureRead(authInfo(), { workspaceId: sourceWorkspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(db => readPhase(db, principal, async () => {
          await assert.rejects(phase(db, principal as unknown as DirectMcpWorkspaceCopyPrincipal,
            async () => assert.fail('Read is not Copy.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(authInfo(), selection, principal => transaction(db => phase(db, principal, async () => {
        await assert.rejects(readPhase(db, principal as unknown as DirectMcpDocumentReadPrincipal,
          async () => assert.fail('Copy is not Read.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      let escaped: DirectMcpWorkspaceCopyPrincipalAccess | undefined, retained: DirectMcpWorkspaceCopyPrincipal | undefined;
      await capture(authInfo(), selection, principal => { retained = principal; return transaction(db => phase(db, principal,
        async access => { escaped = access; })); });
      assert(escaped && retained); await assert.rejects(escaped.assertCurrent(), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(transaction(db => phase(db, retained!, async () => assert.fail('An expired factory handle cannot re-enter.'))),
        expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(capture(authInfo(), selection, principal => transaction(db => phase(db, principal, async () => {
        await assert.rejects(phase(db, principal, async () => assert.fail('A second phase cannot nest.')),
          expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      const pending: Promise<void>[] = [];
      try {
        await assert.rejects(copy(async access => {
          const checkCurrent = access.assertCurrent(); void checkCurrent.catch(() => undefined); pending.push(checkCurrent);
        }), expectedCode('MCP_READ_PRINCIPAL_DETACHED'));
      } finally { await Promise.allSettled(pending); }
    });
    await check('registry preflight rejects wrong scopes, busy, escaped and expired captures without borrowing B', async () => {
      let acquisitions = 0;
      const acquired = () => { acquisitions++; };
      pool.on('acquire', acquired);
      try {
        let escaped: DirectMcpWorkspaceCopyPrincipal | undefined;
        await capture(authInfo(), selection, async principal => {
          escaped = principal; const before = acquisitions;
          preflight(principal, selection); assert.equal(acquisitions, before);
          assert.throws(() => preflight(Object.freeze({}) as DirectMcpWorkspaceCopyPrincipal, selection),
            expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          assert.equal(acquisitions, before);
        });
        assert(escaped); const closed = escaped, before = acquisitions;
        assert.throws(() => preflight(closed, selection), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        assert.equal(acquisitions, before);
        await assert.rejects(captureRead(authInfo(), { workspaceId: sourceWorkspaceId, purpose: 'read' }, () => undefined,
          async principal => {
            const before = acquisitions;
            assert.throws(() => preflight(principal as unknown as DirectMcpWorkspaceCopyPrincipal, selection),
              expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
            assert.equal(acquisitions, before);
          }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(capture(authInfo(), selection, async principal => {
          const before = acquisitions;
          assert.throws(() => preflight(principal, { sourceWorkspaceId: destinationWorkspaceId, destinationWorkspaceId }),
            expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
          assert.throws(() => preflight(principal, selection), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
          assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(capture(authInfo(), selection, principal => transaction(db => phase(db, principal, async () => {
          const before = acquisitions;
          assert.throws(() => preflight(principal, selection), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
          assert.equal(acquisitions, before);
        }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
        const expiry = Math.floor(Date.now() / 1000) + 5;
        const shortToken = await fixture.issue({ scope: 'knowledge:write', exp: expiry }); let entered = false;
        await assert.rejects(capture(authInfo(shortToken), selection, async principal => {
          entered = true; const before = acquisitions; preflight(principal, selection);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now()) + 25));
          assert.throws(() => preflight(principal, selection), expectedCode('MCP_READ_PRINCIPAL_EXPIRED'));
          assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_EXPIRED'));
        assert.equal(entered, true, 'The real JWT must enter its capture before expiring; no substituted clock or claims.');
      } finally { pool.off('acquire', acquired); }
    });
    assert.deepEqual(await fixture.snapshot(), domainBefore, 'Principal and absent-tool probes do not write document/history/projection state.');
  });
  assert.equal(passed, 9); completed = true;
  console.log(`Direct MCP Workspace Copy principal PostgreSQL: ${passed}/9 genuine current JWT/PG/lifetime families; no Copy handler or file publication acceptance.`);
}

void directMcpWorkspaceCopyPrincipalPostgresTest().catch(error => {
  console.error('MCP Copy principal failure:', { currentCase, passed,
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
    constraint: error && typeof error === 'object' ? Reflect.get(error, 'constraint') : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).map(line => line.trim())
      .filter(line => line.startsWith('at ')).slice(0, 8) : undefined });
  process.exitCode = 1;
});
