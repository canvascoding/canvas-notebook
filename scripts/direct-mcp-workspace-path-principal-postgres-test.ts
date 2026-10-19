import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { DirectMcpWorkspaceMovePrincipal, DirectMcpWorkspaceMovePrincipalAccess,
  DirectMcpWorkspaceMoveCurrentOrigin, DirectMcpWorkspaceDeletePrincipal,
  DirectMcpWorkspaceDeletePrincipalAccess, DirectMcpWorkspaceDeleteCurrentOrigin,
  DirectMcpDocumentReadPrincipal } from '../app/lib/mcp/server/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Proposed repository entry: scripts/direct-mcp-workspace-path-principal-postgres-test.ts.
// Actual signed fixture JWTs/current SQL and caller-owned PG18 B. The marker
// proves this authority foundation, not a Move/Delete, original/history binding,
// worker, public handler, OAuth issuance, browser or filesystem operation.
let currentCase = 'setup', passed = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const expectedCode = (wanted: string) => (error: unknown): boolean => {
  assert(error instanceof Error && !(error instanceof assert.AssertionError));
  assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, wanted); return true;
};
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
type PathAccess = DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess;
type PathOrigin = DirectMcpWorkspaceMoveCurrentOrigin | DirectMcpWorkspaceDeleteCurrentOrigin;
type Run = <T>(operation: (access: PathAccess, db: SqlConnection, client: PoolClient, sql: string[]) => Promise<T>,
  actualToken?: string, observe?: (origin: PathOrigin) => void) => Promise<T>;

export async function directMcpWorkspacePathPrincipalPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, clientId, workspaceId } = fixture;
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const { withDirectMcpWorkspaceMovePrincipal: captureMove, withDirectMcpWorkspaceMovePrincipalOnConnection: movePhase,
      assertDirectMcpWorkspaceMovePrincipalCaptured: movePreflight,
      withDirectMcpWorkspaceDeletePrincipal: captureDelete, withDirectMcpWorkspaceDeletePrincipalOnConnection: deletePhase,
      assertDirectMcpWorkspaceDeletePrincipalCaptured: deletePreflight,
      withDirectMcpDocumentReadPrincipal: captureRead, withDirectMcpDocumentReadPrincipalOnConnection: readPhase } =
      await import('../app/lib/mcp/server/document-read-principal');
    const selected = Object.freeze({ workspaceId });
    const tools = 'read_knowledge_source,search_knowledge,create_knowledge_source,edit_knowledge_source,copy_knowledge_source,move_knowledge_source,delete_knowledge_source';
    process.env.CANVAS_MCP_DIRECT_TOOLS = tools;
    assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1,
      can_delete_team_files=1,can_create_public_links=0 WHERE organization_id='tool-dispatch-org'
      AND user_id='reader' AND status='active' RETURNING user_id`)).rowCount, 1);
    assert.equal((await admin.query('UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id=$3',
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId, 'reader'])).rowCount, 1);
    await admin.query('CREATE TABLE path_mcp_principal_writes(id text PRIMARY KEY,backend integer NOT NULL,xid text NOT NULL)');
    const domainBefore = await fixture.snapshot(), token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken,
      clientId: 'untrusted-client-dto', scopes: [], extra: { userId: 'owner', sessionId: 'untrusted-session' } });
    const transaction = async <T>(operation: (db: SqlConnection, client: PoolClient, sql: string[]) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'): Promise<T> => {
      const client = await pool.connect(), sql: string[] = []; let begun = false, discard: Error | undefined;
      const query = async (statement: string, values?: unknown[]) => {
        assert(!/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu.test(statement),
          'A borrowed path principal must not control caller B.');
        sql.push(statement); return client.query(statement, values);
      };
      const db: SqlConnection = { get: async (s, v) => (await query(s, v)).rows[0],
        all: async (s, v) => (await query(s, v)).rows, run: async (s, v) => ({ changes: (await query(s, v)).rowCount ?? 0 }),
        close: () => assert.fail('A borrowed path principal must not close caller B.') };
      try {
        await client.query(begin); begun = true;
        const result = await operation(db, client, sql); await client.query('COMMIT'); begun = false; return result;
      } catch (error) {
        if (begun) try { await client.query('ROLLBACK'); }
        catch (rollback) { discard = new AggregateError([error, rollback], 'Actual path-principal test rollback failed.'); throw discard; }
        throw error;
      } finally { client.release(discard); }
    };
    const runMove: Run = (operation, actualToken = token, observe = () => undefined) =>
      captureMove(authInfo(actualToken), selected, observe, principal => transaction((db, client, sql) =>
        movePhase(db, principal, access => operation(access, db, client, sql))));
    const runDelete: Run = (operation, actualToken = token, observe = () => undefined) =>
      captureDelete(authInfo(actualToken), selected, observe, principal => transaction((db, client, sql) =>
        deletePhase(db, principal, access => operation(access, db, client, sql))));
    const routes = [{ tool: 'move_knowledge_source', run: runMove }, { tool: 'delete_knowledge_source', run: runDelete }] as const;
    const check = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); passed++; console.log(`PASS MCP path principal: ${name}`);
    };
    const facts = async (client: PoolClient) => (await client.query(`SELECT pg_backend_pid() AS pid,
      pg_current_xact_id()::text AS xid,current_schema() AS schema,to_regnamespace(current_schema())::oid::text AS schema_oid,
      current_setting('search_path') AS search_path,current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout,current_setting('transaction_timeout') AS transaction_timeout`)).rows[0];
    const witness = async (db: SqlConnection, id: string) => {
      await db.run('INSERT INTO path_mcp_principal_writes SELECT $1,pg_backend_pid(),pg_current_xact_id()::text', [id]);
      const row = object(await db.get('SELECT backend,xid,xmin::text AS xmin FROM path_mcp_principal_writes WHERE id=$1', [id]));
      assert.equal(row.xmin, (BigInt(String(row.xid)) % BigInt('4294967296')).toString()); return row;
    };
    const absent = async (id: string) => assert.equal((await admin.query(
      'SELECT count(*)::integer AS count FROM path_mcp_principal_writes WHERE id=$1', [id])).rows[0].count, 0);

    await check('both fixed tools use genuine identity, same B/XID and one bounded borrowed phase', async () => {
      for (const route of routes) {
        const origins: PathOrigin[] = [];
        const value = await route.run(async (access, db, client, sql) => {
          assert.equal(access.tool, route.tool); assert.equal(access.userId, 'reader'); assert.equal(access.clientId, clientId);
          assert.equal(access.sessionId, 'reader-session'); assert.equal(access.workspace.workspaceId, workspaceId);
          assert.deepEqual([access.workspace.permissions.canRead, access.workspace.permissions.canWrite,
            access.workspace.permissions.canDelete, access.workspace.permissions.canRunAgent], [true, true, true, true]);
          assert.equal(access.workspace.permissions.canCreatePublicLinks, false);
          for (const value of [access, access.workspace, access.workspace.permissions]) assert(Object.isFrozen(value));
          const before = await facts(client), origin = origins.at(-1); assert(origin);
          assert.equal(origin.tool, route.tool); assert.equal(origin.userId, access.userId); assert.equal(origin.clientId, clientId);
          assert.equal(origin.sessionId, access.sessionId); assert.equal(origin.workspaceId, workspaceId);
          assert.equal(origin.schema, before.schema); assert.equal(String(origin.schemaOid), before.schema_oid);
          assert.equal(origin.searchPath, before.search_path); assert(Object.isFrozen(origin));
          assert.equal(before.lock_timeout, '50ms'); assert.equal(before.statement_timeout, '5s'); assert.equal(before.transaction_timeout, '5s');
          const row = await witness(db, `committed-${route.tool}`); assert.equal(row.backend, before.pid); assert.equal(row.xid, before.xid);
          assert.equal((await admin.query('SELECT count(*)::integer AS count FROM path_mcp_principal_writes WHERE id=$1', [`committed-${route.tool}`])).rows[0].count, 0);
          await access.assertCurrent(); assert.deepEqual(await facts(client), before);
          assert.equal(sql.filter(s => /^SET LOCAL statement_timeout\s*=/iu.test(s)).length, 1); return route.tool;
        }, token, origin => { origins.push(origin); });
        assert.equal(value, route.tool); assert(origins.length >= 3); assert(origins.every(origin => JSON.stringify(origin) === JSON.stringify(origins[0])));
        assert.equal((await admin.query('SELECT count(*)::integer AS count FROM path_mcp_principal_writes WHERE id=$1', [`committed-${route.tool}`])).rows[0].count, 1);
      }
    });

    await check('Write scope and exact opt-in advertise the connected strict Move and Delete handlers', async () => {
      for (const route of routes) {
        for (const scope of ['knowledge:read', 'knowledge:search']) await assert.rejects(route.run(
          async () => assert.fail('Read/Search must not authorize a path write.'), await fixture.issue({ scope })), expectedCode('insufficient_scope'));
        process.env.CANVAS_MCP_DIRECT_TOOLS = tools.split(',').filter(tool => tool !== route.tool).join(',');
        try { await assert.rejects(route.run(async () => assert.fail('Other Write tools are not this fixed policy.')), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
        finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; }
        await route.run(async access => { await access.assertCurrent(); }, await fixture.issue({ scope: 'knowledge:write' }));
      }
      const { DIRECT_MCP_PROTOCOL_VERSION: protocol, DIRECT_MCP_TOOL_IDS, DIRECT_MCP_DEFAULT_TOOL_IDS,
        DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS, DIRECT_MCP_TOOL_CONFIGURATION_VERSION } = await import('../app/lib/mcp/server/config');
      const { buildDirectMcpServerSettingsStatus } = await import('../app/lib/mcp/server/settings-status');
      const { handleDirectMcpPost } = await import('../app/lib/mcp/server/streamable-http');
      assert.equal(DIRECT_MCP_TOOL_CONFIGURATION_VERSION, 7);
      const settings = buildDirectMcpServerSettingsStatus(null); let rpcId = 0;
      const rpc = async (method: string, params: Record<string, unknown>, name?: string) => {
        const id = ++rpcId;
        const response = await handleDirectMcpPost(new Request('http://localhost/mcp', { method: 'POST', headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol,
          'mcp-method': method, ...(name ? { 'mcp-name': name } : {}), authorization: `Bearer ${token}`,
        }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': protocol,
          'io.modelcontextprotocol/clientInfo': { name: 'path-principal-foundation', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } }) }));
        assert.equal(response.status, 200); const body = object(await response.json()); assert.equal(body.id, id); assert.equal(body.jsonrpc, '2.0'); return body;
      };
      const before = await fixture.snapshot();
      const listed = object((await rpc('tools/list', {})).result); assert(Array.isArray(listed.tools) && listed.tools.length > 0);
      for (const route of routes) {
        assert((DIRECT_MCP_TOOL_IDS as readonly string[]).includes(route.tool));
        assert(!(DIRECT_MCP_DEFAULT_TOOL_IDS as readonly string[]).includes(route.tool));
        assert((DIRECT_MCP_EXPLICIT_OPT_IN_TOOL_IDS as readonly string[]).includes(route.tool));
        const capability = settings.capabilities.find(capability => capability.id === route.tool);
        assert(capability); assert.equal(capability.available, true); assert.equal(capability.enabled, true);
        assert.deepEqual(capability.scopes, ['knowledge:write']);
        assert(listed.tools.some(tool => object(tool).name === route.tool));
        const refused = await rpc('tools/call', { name: route.tool, arguments: { workspace_id: workspaceId } }, route.tool);
        assert.equal(Object.hasOwn(refused, 'error'), false);
        const rejected = object(refused.result); assert.equal(rejected.isError, true);
        assert.equal(object(rejected.structuredContent).code, 'INVALID_REQUEST');
        assert.deepEqual(await fixture.snapshot(), before);
      }
    });

    await check('actual opt-in, workspace grant and independent Write/Delete permissions precede the consumer', async () => {
      for (const route of routes) {
        for (const relation of ['mcp_direct_workspace_setting', 'mcp_direct_workspace_grant'] as const) {
          const rows = (await admin.query(`DELETE FROM ${relation} WHERE workspace_id=$1 RETURNING *`, [workspaceId])).rows; assert.equal(rows.length, 1);
          let consumers = 0;
          try { await assert.rejects(route.run(async () => { consumers++; }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
          finally {
            if (relation === 'mcp_direct_workspace_setting') await admin.query(`INSERT INTO mcp_direct_workspace_setting(workspace_id,enabled_by_user_id,enabled_at,updated_at)
              VALUES($1,$2,$3,$4)`, [rows[0].workspace_id, rows[0].enabled_by_user_id, rows[0].enabled_at, rows[0].updated_at]);
            else await admin.query(`INSERT INTO mcp_direct_workspace_grant(client_id,user_id,workspace_id,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5)`, [rows[0].client_id, rows[0].user_id, rows[0].workspace_id, rows[0].created_at, rows[0].updated_at]);
          }
          assert.equal(consumers, 0);
        }
        for (const column of ['can_write_team_workspace', 'can_delete_team_files'] as const) {
          assert.equal((await admin.query(`UPDATE organization_user_permissions SET ${column}=0 WHERE organization_id='tool-dispatch-org' AND user_id='reader' RETURNING user_id`)).rowCount, 1);
          let consumers = 0;
          try { await assert.rejects(route.run(async () => { consumers++; }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
          finally { assert.equal((await admin.query(`UPDATE organization_user_permissions SET ${column}=1 WHERE organization_id='tool-dispatch-org' AND user_id='reader' RETURNING user_id`)).rowCount, 1); }
          assert.equal(consumers, 0);
        }
      }
    });

    const revocations: ReadonlyArray<{ name: string; sql: string; values?: unknown[]; code: string }> = [
      { name: 'write', sql: "UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE organization_id='tool-dispatch-org' AND user_id='reader'", code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
      { name: 'delete', sql: "UPDATE organization_user_permissions SET can_delete_team_files=0 WHERE organization_id='tool-dispatch-org' AND user_id='reader'", code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
      { name: 'grant', sql: 'DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2 AND user_id=$3', values: [workspaceId, clientId, 'reader'], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
      { name: 'client', sql: 'UPDATE oauth_client SET disabled=1 WHERE client_id=$1', values: [clientId], code: 'invalid_token' },
      { name: 'session', sql: "UPDATE \"session\" SET expires_at=1 WHERE id='reader-session'", code: 'invalid_token' },
      { name: 'consent', sql: 'DELETE FROM oauth_consent WHERE client_id=$1 AND user_id=$2', values: [clientId, 'reader'], code: 'invalid_token' },
      { name: 'token', sql: `INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
          VALUES($1,$2,'reader-session','reader',$3,$4)`, values: [crypto.createHash('sha256').update(token).digest('base64url'), clientId, Date.now() + 600000, Date.now()], code: 'invalid_token' },
      { name: 'seat', sql: "UPDATE team_memberships SET status='suspended' WHERE id='reader-seat'", code: 'SEAT_MEMBERSHIP_REQUIRED' },
    ];
    await check('current token/client/SID/consent/grant/seat and ACL revocations poison swallowed checks on B', async () => {
      for (const route of routes) for (const mutation of revocations) {
        const id = `revoked-${route.tool}-${mutation.name}`;
        await assert.rejects(route.run(async (access, db) => {
          await witness(db, id); assert.equal(object(await db.run(mutation.sql, mutation.values)).changes, 1);
          await assert.rejects(access.assertCurrent(), expectedCode(mutation.code));
        }), expectedCode(mutation.code)); await absent(id);
        await route.run(async access => { await access.assertCurrent(); });
      }
    });

    await check('automatic final checks reject without explicit assertCurrent and exact tool disable remains fatal', async () => {
      for (const route of routes) {
        for (const mutation of revocations.filter(value => ['delete', 'grant', 'session', 'consent'].includes(value.name))) {
          const id = `final-${route.tool}-${mutation.name}`;
          await assert.rejects(route.run(async (_access, db) => { await witness(db, id);
            assert.equal(object(await db.run(mutation.sql, mutation.values)).changes, 1); }), expectedCode(mutation.code)); await absent(id);
        }
        try {
          await assert.rejects(route.run(async (access, db) => {
            await witness(db, `disabled-${route.tool}`); process.env.CANVAS_MCP_DIRECT_TOOLS = tools.split(',').filter(tool => tool !== route.tool).join(',');
            await assert.rejects(access.assertCurrent(), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
          }), expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); await absent(`disabled-${route.tool}`);
        } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = tools; }
      }
    });

    await check('caller rollback, realm, XID and auth-table identities cannot be replaced', async () => {
      for (const route of routes) {
        const original = new Error('Expected caller rollback witness.');
        await assert.rejects(route.run(async (_access, db) => { await witness(db, `rollback-${route.tool}`); throw original; }), error => error === original);
        await absent(`rollback-${route.tool}`);
        await assert.rejects(route.run(async (_access, _db, client) => {
          await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); await client.query('SELECT pg_current_xact_id()');
        }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(route.run(async (_access, db) => { await db.run('SET LOCAL search_path=pg_catalog'); }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN READ ONLY']) {
        await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(db => movePhase(db, principal,
          async () => assert.fail('Wrong transaction cannot enter Move.')), begin)), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(captureDelete(authInfo(), selected, () => undefined, principal => transaction(db => deletePhase(db, principal,
          async () => assert.fail('Wrong transaction cannot enter Delete.')), begin)), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(async (db, client) => {
        await client.query('CREATE TEMP TABLE mcp_direct_workspace_grant(client_id text)');
        return movePhase(db, principal, async () => assert.fail('A temporary auth-table shadow cannot enter.'));
      })), expectedCode('MCP_READ_PRINCIPAL_SCHEMA_INVALID'));
    });

    await check('a genuinely renewed SID B is current while expired SID A is denied, without original/history claims', async () => {
      const sessionB = `path-session-${crypto.randomUUID()}`, now = Date.now();
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'reader',$3,$4,$4)`, [sessionB, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const tokenB = await fixture.issue({ sid: sessionB, scope: 'knowledge:write' });
      assert.equal((await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session' RETURNING id`)).rowCount, 1);
      try {
        for (const route of routes) {
          const observed: PathOrigin[] = [];
          await route.run(async access => { assert.equal(access.sessionId, sessionB); assert.equal(access.clientId, clientId);
            assert.equal(access.userId, 'reader'); assert.equal(access.tool, route.tool); await access.assertCurrent(); }, tokenB, origin => { observed.push(origin); });
          assert(observed.length >= 3 && observed.every(origin => origin.sessionId === sessionB && origin.tool === route.tool));
          await assert.rejects(route.run(async () => assert.fail('Expired SID A is not current authority.')), expectedCode('invalid_token'));
        }
      } finally { await fixture.restoreReaderSession(); assert.equal((await admin.query('DELETE FROM "session" WHERE id=$1 RETURNING id', [sessionB])).rowCount, 1); }
    });

    await check('caller selection and token detach before await; proxy/revoked/getter selectors execute zero traps', async () => {
      const moveSelection = { workspaceId }, moveAuth = authInfo();
      const moving = captureMove(moveAuth, moveSelection, () => undefined, principal => transaction(db => movePhase(db, principal,
        async access => { assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.sessionId, 'reader-session'); })));
      moveSelection.workspaceId = `${workspaceId}-changed`; moveAuth.token = 'changed-after-capture'; await moving;
      const deleteSelection = { workspaceId }, deleteAuth = authInfo();
      const deleting = captureDelete(deleteAuth, deleteSelection, () => undefined, principal => transaction(db => deletePhase(db, principal,
        async access => { assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.clientId, clientId); })));
      deleteSelection.workspaceId = `${workspaceId}-changed`; deleteAuth.token = 'changed-after-capture'; await deleting;
      let traps = 0;
      const handler: ProxyHandler<object> = { get() { traps++; throw new Error('Unexpected proxy get.'); },
        ownKeys() { traps++; throw new Error('Unexpected proxy keys.'); }, getPrototypeOf() { traps++; throw new Error('Unexpected proxy prototype.'); },
        getOwnPropertyDescriptor() { traps++; throw new Error('Unexpected proxy descriptor.'); } };
      const revoked = Proxy.revocable({ workspaceId }, handler); revoked.revoke();
      const getter = Object.defineProperty({}, 'workspaceId', { enumerable: true, get() { traps++; return workspaceId; } });
      for (const bad of [new Proxy({ workspaceId }, handler), revoked.proxy, getter]) {
        await assert.rejects(captureMove(authInfo(), bad as typeof selected, () => undefined,
          async () => assert.fail('Hostile options cannot mint Move.')), expectedCode('MCP_READ_PRINCIPAL_INVALID'));
        await assert.rejects(captureDelete(authInfo(), bad as typeof selected, () => undefined,
          async () => assert.fail('Hostile options cannot mint Delete.')), expectedCode('MCP_READ_PRINCIPAL_INVALID')); assert.equal(traps, 0);
      }
    });

    await check('async or throwing origin observers cannot leak a successful consumer result', async () => {
      for (const route of routes) {
        let consumers = 0;
        await assert.rejects(route.run(async () => { consumers++; }, token, async () => undefined), expectedCode('MCP_READ_PRINCIPAL_DETACHED'));
        assert.equal(consumers, 0);
        const original = new Error('Expected synchronous observer rejection.');
        await assert.rejects(route.run(async () => { consumers++; }, token, () => { throw original; }), error => error === original);
        assert.equal(consumers, 0);
      }
    });

    await check('Move, Delete and existing Read brands cannot substitute for or unpoison one another', async () => {
      await assert.rejects(transaction(db => movePhase(db, Object.freeze({}) as DirectMcpWorkspaceMovePrincipal,
        async () => assert.fail('A DTO is not Move.'))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(transaction(db => deletePhase(db, Object.freeze({}) as DirectMcpWorkspaceDeletePrincipal,
        async () => assert.fail('A DTO is not Delete.'))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      // Deliberate wrong-brand casts exist only at hostile public boundaries.
      await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(async db => {
        await assert.rejects(deletePhase(db, principal as unknown as DirectMcpWorkspaceDeletePrincipal, async () => assert.fail('Move is not Delete.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(movePhase(db, principal, async () => assert.fail('Caught wrong-brand misuse remains poisoned.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      })), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureDelete(authInfo(), selected, () => undefined, principal => transaction(async db => {
        await assert.rejects(movePhase(db, principal as unknown as DirectMcpWorkspaceMovePrincipal, async () => assert.fail('Delete is not Move.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(deletePhase(db, principal, async () => assert.fail('Caught wrong-brand misuse remains poisoned.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      })), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureRead(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(db => readPhase(db, principal, async () => {
          await assert.rejects(movePhase(db, principal as unknown as DirectMcpWorkspaceMovePrincipal, async () => assert.fail('Read is not Move.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          await assert.rejects(deletePhase(db, principal as unknown as DirectMcpWorkspaceDeletePrincipal, async () => assert.fail('Read is not Delete.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(db => movePhase(db, principal, async () => {
        await assert.rejects(readPhase(db, principal as unknown as DirectMcpDocumentReadPrincipal, async () => assert.fail('Move is not Read.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      // Existing read policy must still allow a real Read-only workspace.
      assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=0,can_delete_team_files=0
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' RETURNING user_id`)).rowCount, 1);
      try { await captureRead(authInfo(), { workspaceId, purpose: 'read' }, () => undefined, principal => transaction(db => readPhase(db, principal,
        async access => { assert.equal(access.workspace.permissions.canRead, true); assert.equal(access.workspace.permissions.canWrite, false);
          assert.equal(access.workspace.permissions.canDelete, false); await access.assertCurrent(); }))); }
      finally { assert.equal((await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1,can_delete_team_files=1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' RETURNING user_id`)).rowCount, 1); }
    });

    await check('preflights borrow no SQL, enforce scope/kind/busy/lifetime and observe real JWT expiry', async () => {
      let acquisitions = 0; const acquired = () => { acquisitions++; }; pool.on('acquire', acquired);
      try {
        const before = acquisitions;
        assert.throws(() => movePreflight(Object.freeze({}) as DirectMcpWorkspaceMovePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        assert.throws(() => deletePreflight(Object.freeze({}) as DirectMcpWorkspaceDeletePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        assert.equal(acquisitions, before);
        const retained: { move?: DirectMcpWorkspaceMovePrincipal; delete?: DirectMcpWorkspaceDeletePrincipal } = {};
        await captureMove(authInfo(), selected, () => undefined, async principal => { retained.move = principal;
          const before = acquisitions; movePreflight(principal, selected); assert.equal(acquisitions, before); });
        await captureDelete(authInfo(), selected, () => undefined, async principal => { retained.delete = principal;
          const before = acquisitions; deletePreflight(principal, selected); assert.equal(acquisitions, before); });
        assert(retained.move && retained.delete); const afterCapture = acquisitions;
        assert.throws(() => movePreflight(retained.move!, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        assert.throws(() => deletePreflight(retained.delete!, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED')); assert.equal(acquisitions, afterCapture);
        await assert.rejects(captureMove(authInfo(), selected, () => undefined, async principal => {
          const before = acquisitions; assert.throws(() => movePreflight(principal, { workspaceId: `${workspaceId}-other` }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
          assert.throws(() => movePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED')); assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(captureDelete(authInfo(), selected, () => undefined, async principal => {
          const before = acquisitions; assert.throws(() => deletePreflight(principal, { workspaceId: `${workspaceId}-other` }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
          assert.throws(() => deletePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED')); assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
        await assert.rejects(captureMove(authInfo(), selected, () => undefined, async principal => {
          const before = acquisitions; assert.throws(() => deletePreflight(principal as unknown as DirectMcpWorkspaceDeletePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          assert.throws(() => movePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED')); assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(captureDelete(authInfo(), selected, () => undefined, async principal => {
          const before = acquisitions; assert.throws(() => movePreflight(principal as unknown as DirectMcpWorkspaceMovePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          assert.throws(() => deletePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED')); assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(captureRead(authInfo(), { workspaceId, purpose: 'read' }, () => undefined, async principal => {
          const before = acquisitions;
          assert.throws(() => movePreflight(principal as unknown as DirectMcpWorkspaceMovePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          assert.throws(() => deletePreflight(principal as unknown as DirectMcpWorkspaceDeletePrincipal, selected), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          assert.equal(acquisitions, before);
        }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(db => movePhase(db, principal, async () => {
          const before = acquisitions; assert.throws(() => movePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_REENTRANT')); assert.equal(acquisitions, before);
        }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
        await assert.rejects(captureDelete(authInfo(), selected, () => undefined, principal => transaction(db => deletePhase(db, principal, async () => {
          const before = acquisitions; assert.throws(() => deletePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_REENTRANT')); assert.equal(acquisitions, before);
        }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
        for (const kind of ['move', 'delete'] as const) {
          const expiry = Math.floor(Date.now() / 1000) + 5, shortToken = await fixture.issue({ scope: 'knowledge:write', exp: expiry }); let entered = false;
          if (kind === 'move') await assert.rejects(captureMove(authInfo(shortToken), selected, () => undefined, async principal => {
            entered = true; const before = acquisitions; movePreflight(principal, selected);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now()) + 25));
            assert.throws(() => movePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_EXPIRED')); assert.equal(acquisitions, before);
          }), expectedCode('MCP_READ_PRINCIPAL_EXPIRED'));
          else await assert.rejects(captureDelete(authInfo(shortToken), selected, () => undefined, async principal => {
            entered = true; const before = acquisitions; deletePreflight(principal, selected);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now()) + 25));
            assert.throws(() => deletePreflight(principal, selected), expectedCode('MCP_READ_PRINCIPAL_EXPIRED')); assert.equal(acquisitions, before);
          }), expectedCode('MCP_READ_PRINCIPAL_EXPIRED'));
          assert(entered, 'The actual JWT must enter before expiring; no clock or claims replacement.');
        }
      } finally { pool.off('acquire', acquired); }
    });

    await check('escaped access and nested or detached work cannot produce success after callback lifetime', async () => {
      const retained: { move?: DirectMcpWorkspaceMovePrincipal; delete?: DirectMcpWorkspaceDeletePrincipal; accesses: PathAccess[] } = { accesses: [] };
      await captureMove(authInfo(), selected, () => undefined, principal => { retained.move = principal;
        return transaction(db => movePhase(db, principal, async access => { retained.accesses.push(access); })); });
      await captureDelete(authInfo(), selected, () => undefined, principal => { retained.delete = principal;
        return transaction(db => deletePhase(db, principal, async access => { retained.accesses.push(access); })); });
      for (const access of retained.accesses) await assert.rejects(access.assertCurrent(), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      assert(retained.move && retained.delete);
      await assert.rejects(transaction(db => movePhase(db, retained.move!, async () => assert.fail('Escaped Move cannot enter.'))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(transaction(db => deletePhase(db, retained.delete!, async () => assert.fail('Escaped Delete cannot enter.'))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      await assert.rejects(captureMove(authInfo(), selected, () => undefined, principal => transaction(db => movePhase(db, principal, async () => {
        await assert.rejects(movePhase(db, principal, async () => assert.fail('Nested Move cannot enter.')), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      await assert.rejects(captureDelete(authInfo(), selected, () => undefined, principal => transaction(db => deletePhase(db, principal, async () => {
        await assert.rejects(deletePhase(db, principal, async () => assert.fail('Nested Delete cannot enter.')), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      for (const route of routes) {
        const pending: Promise<void>[] = [];
        try { await assert.rejects(route.run(async access => { const check = access.assertCurrent(); void check.catch(() => undefined); pending.push(check); }), expectedCode('MCP_READ_PRINCIPAL_DETACHED')); }
        finally { await Promise.allSettled(pending); }
      }
    });
    assert.deepEqual(await fixture.snapshot(), domainBefore, 'Principal/absent-handler probes do not mutate document/history/projection state.');
  });
  assert.equal(passed, 12); completed = true;
  console.log(`Direct MCP Workspace path principals PostgreSQL: ${passed}/12 genuine JWT/PG authority families; no file, original/history, worker or public-handler acceptance.`);
}

void directMcpWorkspacePathPrincipalPostgresTest().catch(error => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  console.error('MCP path principal failure:', { currentCase, passed,
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code) ? code : null });
  process.exitCode = 1;
});
