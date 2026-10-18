import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { NativeDocumentEditWriteAuthority, NativeDocumentEditWriteAuthorityAccess,
  NativeDocumentEditAuthorityOrigin } from '../app/lib/documents/edit-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine transport factories and caller-owned PostgreSQL B, using the existing
// fixture unchanged. No document mutation, public Edit route, or HTTP/OAuth claim.
let currentCase = 'setup', passed = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const code = (wanted: string) => (error: unknown): boolean => {
  assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted); return true;
};

export async function nativeDocumentEditPrincipalPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId, clientId, agentId, piSessionId } = fixture;
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const { withNativeDocumentEditMcpAuthority: mcp, withNativeDocumentEditRequestAuthority: request,
      withNativeDocumentEditPiAuthority: pi, withNativeDocumentEditWriteAuthorityOnConnection: phase,
      assertNativeDocumentEditWriteAuthorityActive: assertActive, isNativeDocumentEditWriteAuthority: genuine } =
      await import('../app/lib/documents/edit-principal');
    const { withDirectMcpDocumentReadPrincipal: read, withDirectMcpDocumentReadPrincipalOnConnection: readPhase,
      withDirectMcpDocumentCreatePrincipal: create, withDirectMcpDocumentCreatePrincipalOnConnection: createPhase } =
      await import('../app/lib/mcp/server/document-read-principal');
    const allTools = 'read_knowledge_source,search_knowledge,create_knowledge_source,import_knowledge_file,edit_knowledge_source';
    process.env.CANVAS_MCP_DIRECT_TOOLS = allTools;
    await admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId]);
    const token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken,
      clientId: 'untrusted-caller-client', scopes: ['knowledge:write'], extra: { userId: 'owner' } });
    const domainBefore = await fixture.snapshot();
    const transaction = async <T>(action: (db: SqlConnection, client: PoolClient) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'): Promise<T> => {
      const client = await pool.connect(); let began = false, discard: Error | undefined;
      const db: SqlConnection = {
        get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: () => assert.fail('Native Edit principal cannot close borrowed B.'),
      };
      try {
        await client.query(begin); began = true;
        const value = await action(db, client); await client.query('COMMIT'); began = false; return value;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollback) { discard = new AggregateError([error, rollback], 'Native Edit test B rollback failed.'); throw discard; }
        throw error;
      } finally { client.release(discard); }
    };
    const writePermission = async (enabled: boolean) => {
      const result = await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=$1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`, [enabled ? 1 : 0]);
      assert.equal(result.rowCount, 1);
    };
    const edit = <T>(action: (access: NativeDocumentEditWriteAuthorityAccess, db: SqlConnection,
      client: PoolClient, authority: NativeDocumentEditWriteAuthority) => Promise<T>, actualToken = token) =>
      mcp(authInfo(actualToken), { workspaceId }, authority => transaction((db, client) =>
        phase(db, authority, access => action(access, db, client, authority))));
    const check = async (name: string, action: () => Promise<void>) => {
      currentCase = name; await action(); passed++; console.log(`PASS native Edit principal: ${name}`);
    };

    await check('actual MCP Write, exact tool, original realm and caller B are required', async () => {
      await assert.rejects(edit(async () => assert.fail('Actual read-only member cannot edit.')),
        code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      await writePermission(true);
      const originalRealm = (await pool.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path`)).rows[0];
      await edit(async (access, _db, client, authority) => {
        assert(genuine(authority)); assert.equal(access.userId, 'reader'); assert.equal(access.sessionId, 'reader-session');
        assert.equal(access.actorType, 'agent');
        assert.equal(access.actorId, `direct-mcp:${crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`);
        assert.equal(access.actorDisplayName, clientId); assert.equal(access.origin.transport, 'direct-mcp');
        assert(access.origin.transport === 'direct-mcp'); assert.equal(access.origin.clientId, clientId);
        assert.equal(access.origin.tool, 'edit_knowledge_source'); assert.equal(access.origin.searchPath, originalRealm.path);
        assert.deepEqual([access.workspace.permissions.canRead, access.workspace.permissions.canWrite,
          access.workspace.permissions.canRunAgent], [true, true, true]);
        assert(Object.isFrozen(access) && Object.isFrozen(access.origin) && Object.isFrozen(access.workspace));
        assert(!Object.keys(access.origin).some(key => /token|claims|payload/iu.test(key)));
        const facts = async () => (await client.query(`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
          current_schema() AS schema,current_setting('search_path') AS path,current_setting('lock_timeout') AS lock_timeout,
          current_setting('statement_timeout') AS statement_timeout,current_setting('transaction_timeout') AS transaction_timeout`)).rows[0];
        const before = await facts(); assert.match(before.xid, /^[1-9][0-9]*$/u);
        assert.equal(before.schema, originalRealm.schema); assert.equal(before.path, originalRealm.path);
        assert.equal(before.lock_timeout, '50ms'); assert.equal(before.statement_timeout, '5s'); assert.equal(before.transaction_timeout, '5s');
        assertActive(authority); access.assertActive(); await access.assertCurrent(); assertActive(authority);
        assert.deepEqual(await facts(), before);
      });
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('canvas.native-document-edit-write-authorities.v1'));
      assert(descriptor && Object.hasOwn(descriptor, 'value')); assert.equal(descriptor.configurable, false); assert.equal(descriptor.writable, false);
    });

    await check('scope and real Read/Create brands cannot mint a native Edit grant', async () => {
      for (const purpose of ['read', 'search'] as const) {
        await assert.rejects(edit(async () => assert.fail('Read/Search is not Write.'), await fixture.issue({ scope: `knowledge:${purpose}` })),
          code('insufficient_scope'));
        await assert.rejects(read(authInfo(await fixture.issue({ scope: 'knowledge:write' })), { workspaceId, purpose }, () => undefined,
          principal => transaction(db => readPhase(db, principal, async () => assert.fail('Write is not a full Read grant.')))), code('insufficient_scope'));
        await read(authInfo(), { workspaceId, purpose }, () => undefined, principal => transaction(db => readPhase(db, principal, async () => {
          assert.equal(genuine(principal), false);
          await assert.rejects(phase(db, principal as unknown as NativeDocumentEditWriteAuthority, async () => assert.fail('Read handle cannot edit.')),
            code('AUTHENTICATION_REQUIRED'));
        })));
      }
      await create(authInfo(), { workspaceId, tool: 'create_knowledge_source' }, () => undefined,
        principal => transaction(db => createPhase(db, principal, async () => {
          assert.equal(genuine(principal), false);
          await assert.rejects(phase(db, principal as unknown as NativeDocumentEditWriteAuthority, async () => assert.fail('Create handle cannot edit.')),
            code('AUTHENTICATION_REQUIRED'));
        })));
      let traps = 0;
      const forged = new Proxy({}, { get() { traps++; throw new Error('forged getter'); }, getPrototypeOf() { traps++; throw new Error('forged prototype'); } });
      assert.equal(genuine(forged), false); assert.equal(genuine(Object.freeze({})), false);
      await transaction(db => assert.rejects(phase(db, forged as NativeDocumentEditWriteAuthority,
        async () => assert.fail('Proxy cannot become an Authority.')), code('AUTHENTICATION_REQUIRED')));
      assert.equal(traps, 0);
    });

    await check('actual token/session/grant/ACL revocation cannot be swallowed on B', async () => {
      const tokenHash = crypto.createHash('sha256').update(token).digest('base64url'), now = Date.now();
      const changes: readonly { sql: string; values?: unknown[]; error: string }[] = [
        { sql: `INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
          VALUES($1,$2,'reader-session','reader',$3,$4)`, values: [tokenHash, clientId, now + 3600000, now], error: 'invalid_token' },
        { sql: `UPDATE "session" SET expires_at=1 WHERE id='reader-session'`, error: 'invalid_token' },
        { sql: `DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2`, values: [workspaceId, clientId], error: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
        { sql: `UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'`, error: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
      ];
      for (const change of changes) {
        let changed = false;
        await assert.rejects(edit(async (access, db) => {
          await db.run(change.sql, change.values); changed = true;
          await assert.rejects(access.assertCurrent(), code(change.error));
        }), code(change.error));
        assert.equal(changed, true); await edit(async () => undefined); // Actual ROLLBACK restored each auth row.
      }
      try { await assert.rejects(edit(async () => { process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; }),
        code('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
      finally { process.env.CANVAS_MCP_DIRECT_TOOLS = allTools; }
      await mcp(authInfo(), { workspaceId }, async authority => {
        await transaction(db => phase(db, authority, async () => undefined));
        process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source';
        try { await assert.rejects(transaction(db => phase(db, authority, async () => assert.fail('Freshly disabled tool cannot reenter.'))),
          code('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
        finally { process.env.CANVAS_MCP_DIRECT_TOOLS = allTools; }
      }).then(() => assert.fail('Swallowed phase rejection poisons outer factory.'), code('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
    });

    await check('wrong realm, isolation or replaced transaction cannot enter/remain current', async () => {
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN READ ONLY']) {
        await assert.rejects(mcp(authInfo(), { workspaceId }, authority => transaction(db => phase(db, authority,
          async () => assert.fail('Wrong B cannot enter.')), begin)), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(edit(async (_access, _db, client) => {
        await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await client.query('SELECT pg_current_xact_id()');
      }), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(edit(async (_access, db) => { await db.run('SET LOCAL search_path=pg_catalog'); }), code('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
    });

    await check('forged, escaped, reentrant and detached uses poison their actual lifetime', async () => {
      await assert.rejects(mcp(authInfo(), { workspaceId }, async authority => {
        assert(genuine(authority));
        assert.throws(() => assertActive(authority), code('AUTHENTICATION_REQUIRED'));
      }), code('AUTHENTICATION_REQUIRED'));
      let escapedAuthority: NativeDocumentEditWriteAuthority | undefined, escapedAccess: NativeDocumentEditWriteAuthorityAccess | undefined;
      await edit(async (access, _db, _client, authority) => { escapedAccess = access; escapedAuthority = authority; });
      assert(escapedAuthority && escapedAccess); const closedAuthority = escapedAuthority;
      assert.equal(genuine(closedAuthority), false);
      assert.throws(() => assertActive(closedAuthority), code('AUTHENTICATION_REQUIRED'));
      assert.throws(escapedAccess.assertActive, code('AUTHENTICATION_REQUIRED'));
      await assert.rejects(escapedAccess.assertCurrent(), code('AUTHENTICATION_REQUIRED'));
      await assert.rejects(edit(async (_access, db, _client, authority) => {
        await assert.rejects(phase(db, authority, async () => assert.fail('Reentrant phase cannot enter.')), code('DOCUMENT_SCOPE_CHANGED'));
      }), code('DOCUMENT_SCOPE_CHANGED'));
      await assert.rejects(edit(async (_access, db) => {
        await assert.rejects(phase(db, Object.freeze({}) as NativeDocumentEditWriteAuthority,
          async () => assert.fail('Forged handle cannot borrow held phase.')), code('AUTHENTICATION_REQUIRED'));
      }), code('AUTHENTICATION_REQUIRED'));
      const pending: Promise<unknown>[] = [];
      await assert.rejects(edit(async access => {
        const check = access.assertCurrent(); pending.push(check); void check.catch(() => undefined);
      }), code('DOCUMENT_SCOPE_CHANGED'));
      await Promise.allSettled(pending);
      await transaction(db => assert.rejects(mcp(authInfo(), { workspaceId }, async authority => {
        // Register the real phase synchronously on an already borrowed B. An
        // arbitrary detached pool.connect() is outside any authority's scope.
        const detached = phase(db, authority, async () => undefined);
        pending.push(detached); void detached.catch(() => undefined);
      }), code('DOCUMENT_SCOPE_CHANGED')));
      await Promise.allSettled(pending);
    });

    await check('synchronous final guard observes real session expiry after expensive work', async () => {
      let refreshed = false, reachedFinalGuard = false;
      await assert.rejects(edit(async (access, db, _client, authority) => {
        const expiresAt = Date.now() + 1000;
        await db.run(`UPDATE "session" SET expires_at=$1 WHERE id='reader-session'`, [expiresAt]);
        await access.assertCurrent(); refreshed = true;
        assert(Date.now() < expiresAt, 'The real B refresh must finish before the actual session expiry.');
        while (Date.now() <= expiresAt) { /* Model synchronous clone/CAS CPU work without changing the clock. */ }
        reachedFinalGuard = true;
        assertActive(authority);
      }), code('MCP_READ_PRINCIPAL_EXPIRED'));
      assert(refreshed && reachedFinalGuard); await edit(async () => undefined);
    });

    await check('renewed actual SID B is separate from immutable Original A data', async () => {
      let originalA: NativeDocumentEditAuthorityOrigin | undefined;
      await edit(async access => { originalA = access.origin; }); assert(originalA && originalA.transport === 'direct-mcp');
      const historicalA = originalA;
      const originalBytes = JSON.stringify(historicalA), sessionB = `native-edit-B-${crypto.randomUUID()}`, now = Date.now();
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'reader',$3,$4,$4)`, [sessionB, crypto.randomBytes(32).toString('hex'), now + 3600000, now]);
      const tokenB = await fixture.issue({ sid: sessionB, scope: 'knowledge:write' });
      const mutable = authInfo();
      try {
        await mcp(mutable, { workspaceId }, async authority => {
          await transaction(db => phase(db, authority, async access => { assert.equal(access.sessionId, 'reader-session'); }));
          mutable.token = tokenB;
          await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
          await assert.rejects(transaction(db => phase(db, authority, async () => assert.fail('One invocation cannot adopt new SID.'))), code('invalid_token'));
        }).then(() => assert.fail('Original invocation must remain poisoned.'), code('invalid_token'));
        await edit(async access => {
          assert.equal(access.sessionId, sessionB); assert.equal(access.origin.transport, 'direct-mcp');
          assert(access.origin.transport === 'direct-mcp'); assert.equal(access.origin.clientId, clientId);
          assert.deepEqual({ ...access.origin, sessionId: historicalA.sessionId }, historicalA);
        }, tokenB);
        assert.equal(JSON.stringify(historicalA), originalBytes); assert(Object.isFrozen(historicalA));
      } finally { await fixture.restoreReaderSession(); await admin.query('DELETE FROM "session" WHERE id=$1', [sessionB]); }
    });

    await check('genuine REST member credentials create user authority, never MCP/agent attribution', async () => {
      const row = (await admin.query(`SELECT token FROM "session" WHERE id='reader-session'`)).rows[0]; assert.equal(typeof row.token, 'string');
      const incoming = new Request('http://localhost/api/documents/edit', { method: 'POST', headers: { authorization: `Bearer ${row.token}` } });
      await request(incoming, { workspaceId }, authority => transaction(db => phase(db, authority, async access => {
        assert.equal(access.origin.transport, 'request'); assert.equal(access.userId, 'reader'); assert.equal(access.actorId, 'reader');
        assert.equal(access.actorType, 'user'); assert.equal(access.sessionId, 'reader-session'); assertActive(authority);
        assert.equal(Object.hasOwn(access.origin, 'clientId'), false); await access.assertCurrent();
      })));
      await writePermission(false);
      try { await assert.rejects(request(incoming, { workspaceId }, async () => assert.fail('Real REST read-only member cannot edit.')),
        code('PRINCIPAL_ACCESS_DENIED')); }
      finally { await writePermission(true); }
    });

    await check('PI needs actual stored session, current fixed edit_file policy and real invocation', async () => {
      const { resolveAgentExecutionContextForStoredSession } = await import('../app/lib/pi/session-workspace-context');
      const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
      const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
      const invoke = async <T>(tool: string, action: () => Promise<T>) => {
        const actual = await resolveAgentExecutionContextForStoredSession({ sessionId: piSessionId, userId: 'reader', agentId,
          permissions: ['canRead', 'canWrite', 'canRunAgent'] });
        assert.equal(actual.workspaceId, workspaceId);
        return runWithAgentExecutionContext(actual, () => withAgentToolInvocation(actual,
          { toolName: tool, toolCallId: `native-edit-principal-${crypto.randomUUID()}` }, action));
      };
      await fixture.setPiEnabledTools(['edit_file']);
      await assert.rejects(pi({ workspaceId }, async () => assert.fail('Ambient DTO without runtime invocation is not authority.')),
        code('AGENT_TOOL_INVOCATION_REQUIRED'));
      await assert.rejects(invoke('read_document', () => pi({ workspaceId }, async () => assert.fail('Wrong concrete tool is not Edit.'))), code('TOOL_POLICY_DENIED'));
      await invoke('edit_file', () => pi({ workspaceId }, authority => transaction(db => phase(db, authority, async access => {
        assert.equal(access.origin.transport, 'agent-tool'); assert.equal(access.sessionId, piSessionId);
        assert.equal(access.actorType, 'agent'); assert.equal(access.actorId, agentId); assert.equal(access.userId, 'reader');
        assert(access.origin.transport === 'agent-tool'); assert.equal(access.origin.toolName, 'edit_file');
        assert.equal(access.origin.piSessionId, piSessionId); assert.equal(access.origin.agentId, agentId);
        access.assertActive(); await access.assertCurrent(); assertActive(authority);
      }))));
      await assert.rejects(invoke('edit_file', () => pi({ workspaceId }, authority => transaction(db => phase(db, authority, async access => {
        await db.run('UPDATE pi_sessions SET archived_at=1 WHERE session_id=$1', [piSessionId]);
        await assert.rejects(access.assertCurrent(), code('PRINCIPAL_AUTH_REVOKED'));
      })))), code('PRINCIPAL_AUTH_REVOKED'));
      await fixture.setPiEnabledTools(['read_document']);
      await assert.rejects(invoke('edit_file', () => pi({ workspaceId }, authority => transaction(db => phase(db, authority,
        async () => assert.fail('Current disabled tool cannot enter.'))))), code('TOOL_POLICY_DENIED'));
      await fixture.setPiEnabledTools(['read_document']);
    });
    assert.deepEqual(await fixture.snapshot(), domainBefore, 'Principal probes cannot alter document/history/projection rows or xmin.');
  });
  assert.equal(passed, 9); completed = true;
  console.log(`Native document Edit principal PostgreSQL: ${passed}/9 genuine factory/SQL/lifetime families; no Edit mutation or transport acceptance.`);
}

nativeDocumentEditPrincipalPostgresTest().catch(error => {
  console.error('Native document Edit principal failure:', { currentCase, passed,
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
    name: error instanceof Error ? error.name : typeof error });
  process.exitCode = 1;
});
