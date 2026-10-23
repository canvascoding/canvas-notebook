import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../app/lib/db';
import type { DirectMcpDocumentCreateCurrentOrigin, DirectMcpDocumentCreatePrincipal,
  DirectMcpDocumentCreatePrincipalAccess, DirectMcpDocumentCreateTool,
  DirectMcpDocumentReadPrincipal } from '../app/lib/mcp/server/document-read-principal';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Genuine JWT/current SQL/Create-principal probes on the existing owned fixture.
// No verifier, permission, SQL-result, workspace or principal substitutes.
// This does not create a native document or prove HTTP/OAuth/browser activation.
let currentCase = 'setup', passed = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const expectedCode = (wanted: string) => (error: unknown): boolean => {
  assert.equal(error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined, wanted);
  return true;
};

export async function directMcpDocumentCreatePrincipalPostgresTest(): Promise<void> {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { admin, workspaceId, clientId } = fixture;
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const { withDirectMcpDocumentCreatePrincipal: capture, withDirectMcpDocumentCreatePrincipalOnConnection: phase,
      withDirectMcpDocumentReadPrincipal: captureRead, withDirectMcpDocumentReadPrincipalOnConnection: readPhase } =
      await import('../app/lib/mcp/server/document-read-principal');
    const domainBefore = await fixture.snapshot();
    const now = Date.now(), tools: readonly DirectMcpDocumentCreateTool[] = ['create_knowledge_source', 'import_knowledge_file'];
    const allTools = 'read_knowledge_source,search_knowledge,create_knowledge_source,import_knowledge_file';
    process.env.CANVAS_MCP_DIRECT_TOOLS = allTools;
    await admin.query(`UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'`,
      [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), clientId]);
    const token = await fixture.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
    const authInfo = (actualToken = token): AuthInfo => ({ token: actualToken,
      clientId: 'untrusted-caller-client', scopes: ['knowledge:write'], extra: { userId: 'owner' } });

    // Borrow actual B from the existing runtime pool. The principal must never
    // BEGIN/COMMIT/ROLLBACK/close it; this small caller owns its real lease.
    const transaction = async <T>(operation: (db: SqlConnection, client: PoolClient) => Promise<T>,
      begin = 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'): Promise<T> => {
      const client = await pool.connect(); let began = false, discard: Error | undefined;
      const db: SqlConnection = {
        get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: () => assert.fail('A borrowed Create principal cannot close caller B.'),
      };
      try {
        await client.query(begin); began = true;
        const value = await operation(db, client); await client.query('COMMIT'); began = false; return value;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); }
        catch (rollbackError) {
          discard = new AggregateError([error, rollbackError], 'Actual principal-test B rollback failed.'); throw discard;
        }
        throw error;
      } finally { client.release(discard); }
    };
    const create = <T>(operation: (access: DirectMcpDocumentCreatePrincipalAccess, db: SqlConnection,
      client: PoolClient) => Promise<T>, tool: DirectMcpDocumentCreateTool = 'create_knowledge_source',
      actualToken = token, observe: (origin: DirectMcpDocumentCreateCurrentOrigin) => void = () => undefined): Promise<T> =>
      capture(authInfo(actualToken), { workspaceId, tool }, observe,
        principal => transaction((db, client) => phase(db, principal, access => operation(access, db, client))));
    const check = async (name: string, action: () => Promise<void>): Promise<void> => {
      currentCase = name; await action(); passed++; console.log(`PASS Create principal: ${name}`);
    };
    const writePermission = async (enabled: boolean): Promise<void> => {
      const actual = await admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=$1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`, [enabled ? 1 : 0]);
      assert.equal(actual.rowCount, 1);
    };

    await check('both fixed tools use actual current Write authority and caller B/XID', async () => {
      await assert.rejects(create(async () => assert.fail('The genuine read-only fixture cannot create.')),
        expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      await writePermission(true);
      for (const tool of tools) {
        const origins: DirectMcpDocumentCreateCurrentOrigin[] = [];
        const result = await create(async (access, _db, client) => {
          assert.equal(access.userId, 'reader'); assert.equal(access.clientId, clientId);
          assert.equal(access.sessionId, 'reader-session'); assert.equal(access.tool, tool);
          assert.deepEqual([access.workspace.permissions.canRead, access.workspace.permissions.canWrite,
            access.workspace.permissions.canRunAgent], [true, true, true]);
          assert(Object.isFrozen(access) && Object.isFrozen(access.workspace) && Object.isFrozen(access.workspace.permissions));
          const facts = async () => (await client.query(`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
            current_schema() AS schema,current_setting('lock_timeout') AS lock_timeout,
            current_setting('transaction_timeout') AS transaction_timeout,current_setting('statement_timeout') AS statement_timeout`)).rows[0];
          const before = await facts(); assert.match(before.xid, /^[1-9][0-9]*$/u);
          assert(origins[0]); assert.equal(origins[0].schema, before.schema);
          assert.equal(before.lock_timeout, '50ms'); assert.equal(before.transaction_timeout, '5s');
          assert.equal(before.statement_timeout, '5s'); await access.assertCurrent(); assert.deepEqual(await facts(), before);
          return 'actual-current-access';
        }, tool, token, origin => { origins.push(origin); });
        assert.equal(result, 'actual-current-access'); assert(origins.length >= 3);
        for (const origin of origins) {
          assert(Object.isFrozen(origin)); assert.deepEqual(origin, origins[0]); assert.equal(origin.tool, tool);
          assert.equal(origin.clientId, clientId); assert.equal(origin.sessionId, 'reader-session');
          assert(!Object.keys(origin).some(key => /token|claims|payload/iu.test(key)));
        }
      }
    });

    await check('only Create pins the fixed receipt schema path after validating original caller B', async () => {
      const source = (await pool.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path`)).rows[0];
      for (const tool of tools) {
        let actualOrigin: DirectMcpDocumentCreateCurrentOrigin | undefined;
        await create(async (access, _db, client) => {
          const row = (await client.query(`SELECT current_setting('search_path') AS path,
            quote_ident(current_schema())||', pg_catalog, pg_temp' AS receipt_path`)).rows[0];
          assert.equal(row.path, row.receipt_path, 'Create must enter the actual fixed receipt-trigger schema path.');
          assert(actualOrigin); assert.equal(actualOrigin.searchPath, source.path);
          await client.query(`SELECT set_config('search_path',quote_ident(current_schema())||', pg_catalog, pg_temp',true)`);
          await access.assertCurrent();
          assert.equal((await client.query(`SELECT current_setting('search_path') AS path`)).rows[0].path, row.path);
        }, tool, token, origin => { actualOrigin = origin; });
        await assert.rejects(capture(authInfo(), { workspaceId, tool }, () => undefined,
          principal => transaction(async db => {
            await db.run('SET LOCAL search_path=pg_catalog');
            return phase(db, principal, async () => assert.fail('Canonical selection cannot hide a wrong original B realm.'));
          })), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      assert.deepEqual((await pool.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path`)).rows[0], source,
        'SET LOCAL must leave the actual factory source realm unchanged after caller COMMIT.');
      await captureRead(authInfo(), { workspaceId, purpose: 'read' }, () => undefined,
        principal => transaction(db => readPhase(db, principal, async () => {
          const row = await db.get(`SELECT current_setting('search_path') AS path`);
          assert(row && typeof row === 'object' && 'path' in row);
          assert.equal(row.path, source.path,
            'Read keeps its existing exact source path policy.');
        })));
    });

    await check('Write is neither Read/Search scope nor an interchangeable opaque handle', async () => {
      for (const purpose of ['read', 'search'] as const) {
        await assert.rejects(create(async () => assert.fail('Read/Search token is not Write.'), tools[0],
          await fixture.issue({ scope: `knowledge:${purpose}` })), expectedCode('insufficient_scope'));
        await assert.rejects(captureRead(authInfo(await fixture.issue({ scope: 'knowledge:write' })),
          { workspaceId, purpose }, () => undefined, principal => transaction(db => readPhase(db, principal,
            async () => assert.fail('Write token is not Read/Search.')))), expectedCode('insufficient_scope'));
        let consumers = 0;
        await assert.rejects(captureRead(authInfo(), { workspaceId, purpose }, () => undefined,
          principal => transaction(db => readPhase(db, principal, async () => {
            // Deliberate runtime misuse of a REAL differently branded handle.
            await assert.rejects(phase(db, principal as unknown as DirectMcpDocumentCreatePrincipal,
              async () => { consumers++; }), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
          }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        assert.equal(consumers, 0);
      }
      await assert.rejects(capture(authInfo(), { workspaceId, tool: tools[0] }, () => undefined,
        principal => transaction(db => phase(db, principal, async () => {
          await assert.rejects(readPhase(db, principal as unknown as DirectMcpDocumentReadPrincipal,
            async () => assert.fail('Create handle is not Read.')), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
        }))), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
    });

    await check('exact enabled tool, scope and real reachable Workspace permissions are current', async () => {
      for (const deniedTool of tools) {
        process.env.CANVAS_MCP_DIRECT_TOOLS = allTools.split(',').filter(tool => tool !== deniedTool).join(',');
        try {
          await assert.rejects(create(async () => assert.fail('Disabled concrete tool cannot enter.'), deniedTool),
            expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
          await create(async access => { assert.notEqual(access.tool, deniedTool); },
            deniedTool === tools[0] ? tools[1] : tools[0]);
        } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = allTools; }
        try {
          await assert.rejects(create(async () => { process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source'; }, deniedTool),
            expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
        } finally { process.env.CANVAS_MCP_DIRECT_TOOLS = allTools; }
      }
      await writePermission(false);
      try { await assert.rejects(create(async () => assert.fail('Current read-only is not Write.')),
        expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED')); }
      finally { await writePermission(true); }
      await admin.query(`UPDATE organization_user_permissions SET status='disabled'
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`);
      try { await assert.rejects(create(async () => assert.fail('Current membership cannot read/run an agent.')),
        expectedCode('SEAT_MEMBERSHIP_REQUIRED')); }
      finally { await admin.query(`UPDATE organization_user_permissions SET status='active'
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='disabled'`); }
      // Real policy derives canRunAgent from canRead in every workspace type.
      // This is no claim that those two rights were independently revoked.
      const originalEnabled = process.env.CANVAS_MCP_DIRECT_ENABLED;
      try {
        await assert.rejects(create(async () => { process.env.CANVAS_MCP_DIRECT_ENABLED = 'false'; }),
          expectedCode('MCP_READ_PRINCIPAL_ACCESS_DENIED'));
      } finally { process.env.CANVAS_MCP_DIRECT_ENABLED = originalEnabled; }
    });

    await check('actual B token, session, consent, grants and ACL changes poison swallowed failures', async () => {
      const tokenHash = crypto.createHash('sha256').update(token).digest('base64url');
      const mutations: readonly { sql: string; values?: unknown[]; code: string }[] = [
        { sql: `INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
          VALUES($1,$2,'reader-session','reader',$3,$4)`, values: [tokenHash, clientId, now + 3600000, now], code: 'invalid_token' },
        { sql: `UPDATE "session" SET expires_at=1 WHERE id='reader-session'`, code: 'invalid_token' },
        { sql: 'UPDATE oauth_client SET disabled=1 WHERE client_id=$1', values: [clientId], code: 'invalid_token' },
        { sql: `INSERT INTO mcp_direct_grant_revocation(client_id,session_id,user_id,revoked_at)
          VALUES($1,'reader-session','reader',$2)`, values: [clientId, now], code: 'invalid_token' },
        { sql: `INSERT INTO oauth_consent(id,client_id,user_id,scopes,resources,created_at,updated_at)
          VALUES('create-principal-new-consent',$1,'reader','[]','["http://localhost/mcp"]',$2,$2)`,
          values: [clientId, now], code: 'invalid_token' },
        { sql: 'DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2',
          values: [workspaceId, clientId], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
        { sql: 'DELETE FROM mcp_direct_workspace_setting WHERE workspace_id=$1', values: [workspaceId], code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
        { sql: `UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'`, code: 'MCP_READ_PRINCIPAL_ACCESS_DENIED' },
      ];
      for (const mutation of mutations) {
        let changed = false;
        await assert.rejects(create(async (access, db) => {
          await db.run(mutation.sql, mutation.values); changed = true;
          await assert.rejects(access.assertCurrent(), expectedCode(mutation.code));
        }), expectedCode(mutation.code));
        assert.equal(changed, true); await create(async () => undefined); // Actual caller ROLLBACK restored each row.
      }
    });

    await check('real RC/RW realm and original backend transaction cannot be replaced', async () => {
      for (const begin of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'BEGIN READ ONLY']) {
        await assert.rejects(capture(authInfo(), { workspaceId, tool: tools[0] }, () => undefined,
          principal => transaction(db => phase(db, principal, async () => assert.fail('Wrong transaction cannot enter.')), begin)),
        expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      }
      await assert.rejects(create(async (_access, _db, client) => {
        await client.query('COMMIT'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
        await client.query('SELECT pg_current_xact_id()');
      }), expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(create(async (_access, db) => { await db.run('SET LOCAL search_path=pg_catalog'); }),
        expectedCode('MCP_READ_PRINCIPAL_SCOPE_CHANGED'));
      await assert.rejects(capture(authInfo(), { workspaceId, tool: tools[0] }, () => undefined,
        principal => transaction(async (db, client) => {
          await client.query('CREATE TEMP TABLE mcp_direct_workspace_grant(client_id text)');
          return phase(db, principal, async () => assert.fail('Shadowed auth table cannot enter.'));
        })), expectedCode('MCP_READ_PRINCIPAL_SCHEMA_INVALID'));
    });

    await check('expired, escaped, reentrant, pending and asynchronous-observer lifetimes fail closed', async () => {
      let escaped: DirectMcpDocumentCreatePrincipalAccess | undefined;
      await create(async access => { escaped = access; }); assert(escaped);
      await assert.rejects(escaped.assertCurrent(), expectedCode('MCP_READ_PRINCIPAL_REQUIRED'));
      const expiresAt = Math.floor(Date.now() / 1000) + 3;
      const expiring = await fixture.issue({ scope: 'knowledge:write', exp: expiresAt });
      await assert.rejects(capture(authInfo(expiring), { workspaceId, tool: tools[0] }, () => undefined, async principal => {
        // Wait for the actual token boundary before opening B, not a guessed SQL timing window.
        await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, expiresAt * 1000 - Date.now() + 25)));
        return transaction(db => phase(db, principal, async () => assert.fail('Expired capture cannot enter.')));
      }), expectedCode('MCP_READ_PRINCIPAL_EXPIRED'));
      await assert.rejects(capture(authInfo(), { workspaceId, tool: tools[0] }, () => undefined,
        principal => transaction(db => phase(db, principal, async () => {
          await assert.rejects(phase(db, principal, async () => assert.fail('Reentrant consumer cannot enter.')),
            expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
        }))), expectedCode('MCP_READ_PRINCIPAL_REENTRANT'));
      const pendingChecks: Promise<void>[] = [];
      await assert.rejects(create(async access => {
        const pending = access.assertCurrent(); void pending.catch(() => undefined); pendingChecks.push(pending);
      }), expectedCode('MCP_READ_PRINCIPAL_DETACHED'));
      await Promise.allSettled(pendingChecks);
      for (const tool of tools) {
        let observed = 0, entered = false;
        await assert.rejects(create(async () => { entered = true; }, tool, token,
          async () => { observed++; }), expectedCode('MCP_READ_PRINCIPAL_DETACHED'));
        assert.equal(observed, 1); assert.equal(entered, false);
      }
    });

    await check('renewed real SID B is current authority while Original A remains only immutable data', async () => {
      const originsA: DirectMcpDocumentCreateCurrentOrigin[] = [];
      await create(async () => undefined, tools[0], token, origin => { originsA.push(origin); });
      assert(originsA[0]); const originalA = originsA[0], originalJson = JSON.stringify(originalA);
      const refreshed = await fixture.issue({ scope: 'knowledge:write', exp: Math.floor(Date.now() / 1000) + 900 });
      assert.notEqual(refreshed, token);
      await create(async access => { assert.equal(access.sessionId, originalA.sessionId); }, tools[0], refreshed);
      const sessionB = `create-principal-session-${crypto.randomUUID()}`;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'reader',$3,$4,$4)`, [sessionB, crypto.randomBytes(32).toString('hex'), Date.now() + 3600000, now]);
      const tokenB = await fixture.issue({ sid: sessionB, scope: 'knowledge:write' });
      const originsB: DirectMcpDocumentCreateCurrentOrigin[] = [];
      await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
      try {
        await create(async access => { assert.equal(access.sessionId, sessionB); }, tools[0], tokenB,
          origin => { originsB.push(origin); });
      } finally { await fixture.restoreReaderSession(); }
      assert(originsB[0]); assert.equal(originsB[0].sessionId, sessionB); assert.notEqual(sessionB, originalA.sessionId);
      assert.equal(JSON.stringify(originalA), originalJson); assert(Object.isFrozen(originalA));
      assert.deepEqual({ ...originsB[0], sessionId: originalA.sessionId }, originalA);
      const key = `same-original-key-${crypto.randomUUID()}`;
      const operationKey = (origin: DirectMcpDocumentCreateCurrentOrigin): string => crypto.createHash('sha256')
        .update(JSON.stringify([origin.clientId, origin.userId, origin.workspaceId, key])).digest('hex');
      assert.equal(operationKey(originsB[0]), operationKey(originalA));
      // This equality is primitive historical comparison, not a Native receipt/recovery claim.
      const mutableInput = authInfo(), beforeChange: DirectMcpDocumentCreateCurrentOrigin[] = [];
      try {
        await assert.rejects(capture(mutableInput, { workspaceId, tool: tools[0] }, origin => { beforeChange.push(origin); },
          async principal => {
            await transaction(db => phase(db, principal, async access => { assert.equal(access.sessionId, 'reader-session'); }));
            mutableInput.token = tokenB;
            await admin.query(`UPDATE "session" SET expires_at=1 WHERE id='reader-session'`);
            await transaction(db => phase(db, principal, async () => assert.fail('A live capture cannot adopt new SID B.')));
          }), expectedCode('invalid_token'));
      } finally { await fixture.restoreReaderSession(); }
      assert(beforeChange.length >= 2); assert(beforeChange.every(origin => origin.sessionId === 'reader-session'));
      await admin.query('DELETE FROM "session" WHERE id=$1', [sessionB]);
    });
    assert.deepEqual(await fixture.snapshot(), domainBefore, 'Principal probes never mutate native documents/history/projections.');
  });
  assert.equal(passed, 8); completed = true;
  console.log(`Direct MCP Create principal PostgreSQL: ${passed}/8 genuine JWT/SQL/lifetime families; no native Create, HTTP, browser or host acceptance.`);
}

directMcpDocumentCreatePrincipalPostgresTest().catch(error => {
  console.error('Direct MCP Create principal failure:', { currentCase, passed,
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
    name: error instanceof Error ? error.name : typeof error });
  process.exitCode = 1;
});
