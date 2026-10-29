import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SqlConnection } from '../app/lib/db';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

await withDocumentReadToolDispatchFixture(async h => {
  const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
  const principal = await import('../app/lib/mcp/server/document-read-principal');
  const pool = getPostgresRuntimeQueryable(); assert(pool);
  const schema = (await h.admin.query('SELECT current_schema() AS schema')).rows[0].schema as string;
  process.env.CANVAS_MCP_DIRECT_TOOLS = 'read_knowledge_source,search_knowledge,create_knowledge_source,import_knowledge_file,edit_knowledge_source';
  await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE user_id='reader'");
  await h.admin.query("UPDATE oauth_consent SET scopes=$1 WHERE client_id=$2 AND user_id='reader'",
    [JSON.stringify(['knowledge:read', 'knowledge:search', 'knowledge:write']), h.clientId]);
  const token = await h.issue({ scope: 'knowledge:read knowledge:search knowledge:write' });
  const tokenHash = createHash('sha256').update(token).digest('base64url');
  await h.seed({ filePath: 'snapshot/original.md', text: '# Original snapshot source\n' });
  const authTables = ['user', 'session', 'canvas_organization_settings', 'organization_user_permissions', 'team_memberships',
    'team_membership_sync_state', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members',
    'oauth_client', 'oauth_consent', 'mcp_revoked_access_token', 'mcp_direct_grant_revocation',
    'mcp_direct_workspace_setting', 'mcp_direct_workspace_grant'];
  const beforeState = async () => {
    const authority: Record<string, unknown> = {};
    for (const name of authTables) authority[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,xmin::text AS xmin
      FROM "${schema}"."${name}" r ORDER BY to_jsonb(r)::text,xmin::text`)).rows;
    const columns = (await h.admin.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attname`, [schema, authTables])).rows;
    return { authority, columns, domain: await h.snapshot() };
  };
  const faults = ['control', 'account-ban', 'session-expiry', 'session-missing', 'client-disabled', 'token-revoked',
    'grant-revoked', 'newer-consent', 'opt-out', 'grant-removed', 'seat-revoked', 'write-revoked', 'workspace-root',
    'workspace-disabled', 'search-path', 'relation-shadow', 'relation-missing', 'account-numeric', 'client-numeric',
    'write-numeric-one', 'unsupported-flag-domain', 'unsupported-session-date'] as const;
  let groups = 0;
  for (const mode of ['prepared', 'fallback'] as const) for (const kind of ['read', 'create', 'edit'] as const) for (const fault of faults) {
    const before = await beforeState();
    let entered = false, checked = false, published = false, injected = false, failure: unknown;
    const rollbackRead = new Error('Read survives write-only loss; rollback the real fixture mutation.');
    const authInfo = { token, clientId: 'ignored-untrusted-client', scopes: [] };
    const operation = async (p: unknown) => {
      const client = await pool.connect(); let began = false, discard: Error | undefined, measure = false, sql = 0;
      const observations: Array<Record<string, unknown>> = [];
      const mutate = async () => {
        injected = true;
        if (fault === 'account-ban') await client.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
        if (fault === 'session-expiry') await client.query('UPDATE "session" SET expires_at=1 WHERE id=$1', ['reader-session']);
        if (fault === 'session-missing') await client.query('DELETE FROM "session" WHERE id=$1', ['reader-session']);
        if (fault === 'client-disabled') await client.query('UPDATE oauth_client SET disabled=1 WHERE client_id=$1', [h.clientId]);
        if (fault === 'token-revoked') await client.query(`INSERT INTO mcp_revoked_access_token(token_hash,client_id,session_id,user_id,expires_at,revoked_at)
          VALUES($1,$2,'reader-session','reader',$3,$4)`, [tokenHash, h.clientId, Date.now() + 3600000, Date.now()]);
        if (fault === 'grant-revoked') await client.query(`INSERT INTO mcp_direct_grant_revocation(client_id,session_id,user_id,revoked_at)
          VALUES($1,'reader-session','reader',$2)`, [h.clientId, Date.now()]);
        if (fault === 'newer-consent') await client.query('UPDATE oauth_consent SET updated_at=$1 WHERE client_id=$2', [Date.now() + 1000, h.clientId]);
        if (fault === 'opt-out') await client.query('DELETE FROM mcp_direct_workspace_setting WHERE workspace_id=$1', [h.workspaceId]);
        if (fault === 'grant-removed') await client.query('DELETE FROM mcp_direct_workspace_grant WHERE workspace_id=$1 AND client_id=$2', [h.workspaceId, h.clientId]);
        if (fault === 'seat-revoked') await client.query("UPDATE team_memberships SET status='suspended' WHERE user_id='reader'");
        if (fault === 'write-revoked') await client.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'");
        if (fault === 'workspace-root') await client.query("UPDATE canvas_workspaces SET root_relative_path=root_relative_path||'/changed' WHERE id=$1", [h.workspaceId]);
        if (fault === 'workspace-disabled') await client.query("UPDATE canvas_workspaces SET status='disabled' WHERE id=$1", [h.workspaceId]);
        if (fault === 'search-path') await client.query(`SET LOCAL search_path=pg_catalog,"${schema}",pg_temp`);
        if (fault === 'relation-shadow') {
          // Create has an explicit pg_temp suffix: force a real shadow in both
          // path policies instead of assuming a same-named temp table wins.
          await client.query('ALTER TABLE oauth_client RENAME TO snapshot_original_client');
          await client.query(`CREATE TEMP TABLE oauth_client (LIKE "${schema}".snapshot_original_client INCLUDING ALL)`);
          assert.equal((await client.query(`SELECT to_regclass('oauth_client')::oid IS DISTINCT FROM
            to_regclass(quote_ident($1)||'.oauth_client')::oid AS shadow`, [schema])).rows[0].shadow, true);
        }
        if (fault === 'relation-missing') await client.query('ALTER TABLE oauth_client RENAME TO snapshot_original_client');
        if (fault === 'account-numeric') {
          await client.query('ALTER TABLE "user" ALTER COLUMN banned TYPE numeric USING banned::numeric');
          await client.query("UPDATE \"user\" SET banned=1.00000000000000000001 WHERE id='reader'");
        }
        if (fault === 'client-numeric') {
          await client.query('ALTER TABLE oauth_client ALTER COLUMN disabled TYPE numeric USING disabled::numeric');
          await client.query('UPDATE oauth_client SET disabled=0.00000000000000000001 WHERE client_id=$1', [h.clientId]);
        }
        if (fault === 'write-numeric-one') await client.query(`ALTER TABLE organization_user_permissions
          ALTER COLUMN can_write_team_workspace TYPE numeric USING can_write_team_workspace::numeric`);
        if (fault === 'unsupported-flag-domain') {
          await client.query('CREATE DOMAIN snapshot_flag_number AS numeric');
          await client.query('ALTER TABLE oauth_client ALTER COLUMN disabled TYPE snapshot_flag_number USING disabled::numeric');
        }
        if (fault === 'unsupported-session-date') await client.query(`ALTER TABLE "session" ALTER COLUMN expires_at DROP DEFAULT,
          ALTER COLUMN expires_at TYPE date USING to_timestamp(expires_at/1000.0)::date`);
      };
      const read = async (text: string, values?: unknown[], prepared = false) => {
          if (measure) sql++;
          const row = (await (prepared ? client.query({ name: 'actual_mcp_slot_snapshot_probe', text, values }) : client.query(text, values))).rows[0];
          const facts = row?.facts ?? row;
          if (measure && Array.isArray(facts?.schema_relations)) observations.push(facts);
          // Forward the genuine first joined reply after a real same-B change.
          if (measure && !injected && fault !== 'control' && facts?.raw_id === 'reader' && Array.isArray(facts.schema_relations)) await mutate();
          return row;
      };
      const db: SqlConnection = {
        get: (text, values) => read(text, values),
        ...(mode === 'prepared' ? { getPrepared: (text: string, values?: unknown[]) => read(text, values, true) } : {}),
        all: async (text, values) => { if (measure) sql++; return (await client.query(text, values)).rows; },
        run: async (text, values) => { if (measure) sql++; return { changes: (await client.query(text, values)).rowCount ?? 0 }; },
        close: () => assert.fail('The Principal does not own caller B.'),
      };
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        const callback = async (access: { assertCurrent: () => Promise<void>; assertActive?: () => void }) => {
          entered = true; measure = true;
          try { await access.assertCurrent(); } finally { measure = false; }
          checked = true;
          console.log('MCP_SLOT_SNAPSHOT_COUNTS', JSON.stringify({ mode, kind, fault, sql }));
          assert.equal(sql, 3, 'Current retains its pre-runtime schema fence and two fresh complete fact snapshots.');
          assert.equal(observations.length, 3);
          assert(observations.every(row => row.backend === observations[0].backend && row.xid === observations[0].xid));
          if (kind === 'edit') { assert.equal(typeof access.assertActive, 'function'); access.assertActive!(); }
          if (kind === 'read' && ['write-revoked', 'write-numeric-one'].includes(fault)) throw rollbackRead;
          assert.equal(fault, 'control', 'A fault must roll back even if an unexpected Current was allowed.');
          sql = 0; measure = true;
          try { await access.assertCurrent(); } finally { measure = false; }
          assert.equal(sql, 3, 'Another Current must repeat all three fresh reads.');
          return 'current-mcp';
        };
        const result = kind === 'read'
          ? await principal.withDirectMcpDocumentReadPrincipalOnConnection(db, p as Parameters<typeof principal.withDirectMcpDocumentReadPrincipalOnConnection>[1], callback)
          : kind === 'create'
            ? await principal.withDirectMcpDocumentCreatePrincipalOnConnection(db, p as Parameters<typeof principal.withDirectMcpDocumentCreatePrincipalOnConnection>[1], callback)
            : await principal.withDirectMcpDocumentEditPrincipalOnConnection(db, p as Parameters<typeof principal.withDirectMcpDocumentEditPrincipalOnConnection>[1], callback);
        await client.query('COMMIT'); began = false; return result;
      } catch (error) {
        if (began) try { await client.query('ROLLBACK'); } catch (rollbackError) {
          discard = new AggregateError([error, rollbackError], 'Actual snapshot fixture rollback failed.'); throw discard;
        }
        throw error;
      } finally { client.release(discard); }
    };
    try {
      const result = kind === 'read'
        ? await principal.withDirectMcpDocumentReadPrincipal(authInfo, { workspaceId: h.workspaceId, purpose: 'read' }, () => undefined, operation)
        : kind === 'create'
          ? await principal.withDirectMcpDocumentCreatePrincipal(authInfo, { workspaceId: h.workspaceId, tool: 'create_knowledge_source' }, () => undefined, operation)
          : await principal.withDirectMcpDocumentEditPrincipal(authInfo, { workspaceId: h.workspaceId }, () => undefined, operation);
      published = result === 'current-mcp';
    } catch (error) { failure = error; }
    assert(entered);
    if (fault === 'control') { if (failure) throw failure; assert(checked && published && !injected); }
    else if (kind === 'read' && ['write-revoked', 'write-numeric-one'].includes(fault)) {
      assert(checked && injected && !published); assert.equal(failure, rollbackRead);
    } else {
      assert(injected && !checked && !published);
      const code = failure && typeof failure === 'object' ? Reflect.get(failure, 'code') : undefined;
      assert.equal(code, ['account-ban', 'session-expiry', 'client-disabled', 'token-revoked', 'grant-revoked', 'newer-consent'].includes(fault)
        ? 'invalid_token' : fault === 'seat-revoked' ? 'SEAT_MEMBERSHIP_REQUIRED'
          : fault === 'workspace-root' || fault === 'search-path' ? 'MCP_READ_PRINCIPAL_SCOPE_CHANGED'
            : fault.startsWith('relation-') || fault.startsWith('unsupported-') ? 'MCP_READ_PRINCIPAL_SCHEMA_INVALID' : 'MCP_READ_PRINCIPAL_ACCESS_DENIED', `${kind}/${fault}: ${String(failure)}`);
    }
    assert.deepEqual(await beforeState(), before, 'Authority/native rows/xmin and actual column types remain unchanged after controls/rollback.');
    groups++;
  }
  assert.equal(groups, 132);
  console.log('MCP_SLOT_SNAPSHOT_PROOF', JSON.stringify({ groups, currentSql: 3, originalReplies: true,
    betweenReplyRevocation: true, exactScalarFlags: true, authorityNativeRowsXminAndColumnTypesUnchanged: true }));
});
