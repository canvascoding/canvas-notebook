import assert from 'node:assert/strict';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import type { SqlConnection } from '../app/lib/db';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { authority, readActorMembershipAuthorityOnConnection: read } = await import('../app/lib/capabilities/scope-authority');
    const { resolveVerifiedAgentActorContextOnConnection, AgentActorContextError } = await import('../app/lib/agents/actor-context');
    const { openDb } = await import('../app/lib/db');
    const authRows = `SELECT
      (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM "user" u) AS users,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY organization_id) FROM canvas_organization_settings o) AS organizations,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id,user_id) FROM organization_user_permissions p) AS permissions`;
    const baseline = (await fixture.admin.query(authRows)).rows;
    const rawRowsSql = [
      'SELECT xmin::text AS row_xmin, * FROM "user" ORDER BY id',
      'SELECT xmin::text AS row_xmin, * FROM canvas_organization_settings ORDER BY organization_id',
      'SELECT xmin::text AS row_xmin, * FROM organization_user_permissions ORDER BY organization_id,user_id',
      `SELECT c.relname,a.attname,a.atttypid::text,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname=current_schema() AND c.relname IN ('user','canvas_organization_settings','organization_user_permissions')
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
    ];
    const rawSnapshot = async (readRows: (sql: string) => ReturnType<SqlConnection['all']>) => {
      const rows: unknown[][] = [];
      for (const sql of rawRowsSql) rows.push(await readRows(sql));
      return rows;
    };
    const rawBaseline = await rawSnapshot(async sql => (await fixture.admin.query(sql)).rows);
    const numericShare = 'ALTER TABLE organization_user_permissions ALTER COLUMN can_share_plugins_and_skills TYPE numeric USING can_share_plugins_and_skills::numeric';
    const numericBanned = 'ALTER TABLE "user" ALTER COLUMN banned TYPE numeric USING banned::numeric';
    const booleanShare = ['ALTER TABLE organization_user_permissions ALTER COLUMN can_share_plugins_and_skills DROP DEFAULT',
      'ALTER TABLE organization_user_permissions ALTER COLUMN can_share_plugins_and_skills TYPE boolean USING (can_share_plugins_and_skills=1)'];
    const booleanBanned = ['ALTER TABLE "user" ALTER COLUMN banned DROP DEFAULT',
      'ALTER TABLE "user" ALTER COLUMN banned TYPE boolean USING (banned=1)'];
    const variants: Array<{ name: string; userId?: string; changes?: string[]; valid: boolean; organizationId?: string | null;
      canShare?: boolean; rawShare?: unknown; rawBanned?: unknown }> = [
      { name: 'active member', valid: true },
      { name: 'active owner', userId: 'owner', valid: true },
      { name: 'missing user', userId: 'absent', valid: false },
      { name: 'banned user', changes: [`UPDATE "user" SET banned=1 WHERE id='reader'`], valid: false },
      { name: 'missing membership', changes: [`DELETE FROM organization_user_permissions WHERE user_id='reader'`], valid: false },
      { name: 'disabled membership', changes: [`UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'`], valid: false },
      { name: 'external role remains an active account', changes: [`UPDATE organization_user_permissions SET role='external' WHERE user_id='reader'`], valid: true },
      { name: 'share permission flag', changes: [`UPDATE organization_user_permissions SET can_share_plugins_and_skills=1 WHERE user_id='reader'`], valid: true },
      { name: 'stale global admin role cannot replace current membership', changes: [
        `UPDATE "user" SET role='admin' WHERE id='reader'`, `UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'`], valid: false },
      { name: 'unconfigured legacy account retains missing organization', changes: ['TRUNCATE canvas_organization_settings CASCADE'], valid: true, organizationId: null },
      { name: 'unconfigured banned account stays denied', changes: ['TRUNCATE canvas_organization_settings CASCADE', `UPDATE "user" SET banned=1 WHERE id='reader'`], valid: false, organizationId: null },
      { name: 'earliest configured organization remains explicit', changes: [
        `INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
          VALUES('earlier-org','owner','team',1,1,1)`], valid: true, organizationId: 'earlier-org' },
      { name: 'another active membership does not invent membership in the configured organization', changes: [
        `INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
          VALUES('other-org','owner','team',1,200,200)`,
        `INSERT INTO organization_user_permissions(organization_id,user_id,role,status,created_at,updated_at)
          VALUES('other-org','reader','member','active',100,100)`,
        `UPDATE organization_user_permissions SET status='disabled' WHERE organization_id='tool-dispatch-org' AND user_id='reader'`], valid: true },
      { name: 'NUMERIC exact one retains the scalar share decision', changes: [numericShare,
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=1 WHERE user_id='reader'"],
        valid: true, canShare: true, rawShare: '1' },
      { name: 'NUMERIC above one cannot gain sharing through JSON rounding', changes: [numericShare,
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=1.00000000000000000001 WHERE user_id='reader'"],
        valid: true, canShare: false, rawShare: '1.00000000000000000001' },
      { name: 'NUMERIC scaled one retains the existing lexical flag decision', changes: [numericShare,
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=1.00000000000000000000 WHERE user_id='reader'"],
        valid: true, canShare: false, rawShare: '1.00000000000000000000' },
      { name: 'NUMERIC below one cannot gain sharing through JSON rounding', changes: [numericShare,
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=0.99999999999999999999 WHERE user_id='reader'"],
        valid: true, canShare: false, rawShare: '0.99999999999999999999' },
      { name: 'NUMERIC exact banned one remains denied', changes: [numericBanned,
        "UPDATE \"user\" SET banned=1 WHERE id='reader'"], valid: false, rawBanned: '1' },
      { name: 'NUMERIC banned fraction retains the existing scalar account decision', changes: [numericBanned,
        "UPDATE \"user\" SET banned=1.00000000000000000001 WHERE id='reader'"],
        valid: true, rawBanned: '1.00000000000000000001' },
      { name: 'NUMERIC scaled banned one retains the existing lexical account decision', changes: [numericBanned,
        "UPDATE \"user\" SET banned=1.00000000000000000000 WHERE id='reader'"],
        valid: true, rawBanned: '1.00000000000000000000' },
      { name: 'NUMERIC domain share fraction retains its driver value', changes: [
        'CREATE DOMAIN authority_flag_numeric AS numeric',
        'ALTER TABLE organization_user_permissions ALTER COLUMN can_share_plugins_and_skills TYPE authority_flag_numeric USING can_share_plugins_and_skills::authority_flag_numeric',
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=1.00000000000000000001 WHERE user_id='reader'"],
        valid: true, canShare: false, rawShare: '1.00000000000000000001' },
      { name: 'NUMERIC domain banned fraction retains its driver value', changes: [
        'CREATE DOMAIN authority_flag_numeric AS numeric',
        'ALTER TABLE "user" ALTER COLUMN banned TYPE authority_flag_numeric USING banned::authority_flag_numeric',
        "UPDATE \"user\" SET banned=1.00000000000000000001 WHERE id='reader'"],
        valid: true, rawBanned: '1.00000000000000000001' },
      { name: 'BOOLEAN sharing and account flags retain native booleans', changes: [...booleanShare, ...booleanBanned,
        "UPDATE organization_user_permissions SET can_share_plugins_and_skills=true WHERE user_id='reader'"],
        valid: true, canShare: true, rawShare: true, rawBanned: false },
      { name: 'BOOLEAN banned true remains denied', changes: [...booleanBanned,
        "UPDATE \"user\" SET banned=true WHERE id='reader'"], valid: false, rawBanned: true },
    ];
    for (const variant of variants) {
      const database = await openDb(), statements: string[] = [];
      const observed: SqlConnection = {
        get: (sql, values) => { statements.push(sql); return database.get(sql, values); },
        all: (sql, values) => { statements.push(sql); return database.all(sql, values); },
        run: () => assert.fail('The account reader must never write or control a transaction.'),
        close: () => assert.fail('The account reader does not own the connection.'),
      };
      try {
        await database.run('BEGIN');
        for (const change of variant.changes ?? []) await database.run(change);
        const before = await database.get(authRows), userId = variant.userId ?? 'reader';
        const rawBefore = await rawSnapshot(sql => database.all(sql));
        if (Object.hasOwn(variant, 'rawShare')) {
          const raw = await database.get('SELECT can_share_plugins_and_skills AS value FROM organization_user_permissions WHERE user_id=$1', [userId]);
          assert(raw && typeof raw === 'object');
          assert.equal(Reflect.get(raw, 'value'), variant.rawShare, `${variant.name}: the real driver must retain the arranged share value`);
        }
        if (Object.hasOwn(variant, 'rawBanned')) {
          const raw = await database.get('SELECT banned AS value FROM "user" WHERE id=$1', [userId]);
          assert(raw && typeof raw === 'object');
          assert.equal(Reflect.get(raw, 'value'), variant.rawBanned, `${variant.name}: the real driver must retain the arranged account value`);
        }
        for (const lock of [false, true]) {
          statements.length = 0;
          const current = await read(observed, userId, lock);
          assert.equal(statements.length, lock ? 3 : 1, `${variant.name}: bounded current SQL observations`);
          assert(statements.every(sql => !/\b(?:canvas_workspaces|canvas_workspace_members|canvas_projects|canvas_project_members)\b/u.test(sql)),
            'An account-only observation must not enumerate workspaces or projects.');
          if (lock) {
            assert(statements.every(sql => sql.includes('FOR SHARE')));
            assert(statements[0].includes('canvas_organization_settings')); assert(statements[1].includes('FROM "user"'));
            assert(statements[2].includes('organization_user_permissions'));
          }
          const full = await authority(database, { userId }, lock);
          assert.deepEqual({ userId: current.userId, valid: current.valid, memberships: current.memberships },
            { userId: full.userId, valid: full.valid, memberships: full.memberships }, variant.name);
          assert.equal(current.valid, variant.valid, variant.name);
          if (Object.hasOwn(variant, 'canShare')) assert.equal(current.memberships.get('tool-dispatch-org')?.canShare, variant.canShare, variant.name);
          assert.equal(current.organizationId, Object.hasOwn(variant, 'organizationId') ? variant.organizationId : 'tool-dispatch-org');
          assert.equal(Object.hasOwn(current, 'workspaces'), false); assert.equal(Object.hasOwn(current, 'requestedWorkspace'), false);
          assert.deepEqual(await database.get(authRows), before, 'Both readers are read-only.');
          assert.deepEqual(await rawSnapshot(sql => database.all(sql)), rawBefore,
            'Neither reader may change raw values, xmin or column types/defaults.');
          if (Object.hasOwn(variant, 'rawBanned')) {
            statements.length = 0;
            if (variant.valid) {
              const actor = await resolveVerifiedAgentActorContextOnConnection({ userId }, observed, { lock });
              assert.equal(actor.userId, userId); assert.equal(actor.organizationId, 'tool-dispatch-org');
              assert.equal(actor.organizationRole, 'member'); assert.deepEqual(actor.context, {});
            } else {
              await assert.rejects(resolveVerifiedAgentActorContextOnConnection({ userId }, observed, { lock }),
                error => error instanceof AgentActorContextError && error.code === 'AGENT_ACTOR_CONTEXT_DENIED');
            }
            assert.equal(statements.length, lock ? 3 : 1, 'The actual actor consumer retains the bounded current observation.');
            assert.deepEqual(await rawSnapshot(sql => database.all(sql)), rawBefore);
          }
        }
      } finally { try { await database.run('ROLLBACK'); } finally { await database.close(); } }
      assert.deepEqual((await fixture.admin.query(authRows)).rows, baseline, 'Fixture changes must roll back exactly.');
      assert.deepEqual(await rawSnapshot(async sql => (await fixture.admin.query(sql)).rows), rawBaseline,
        'Original raw rows/xmin and actual column types/defaults must return after rollback.');
    }
    const database = await openDb();
    try {
      await database.run('BEGIN');
      const first = await read(database, 'reader', true); assert.equal(first.valid, true);
      // Independent real SQL sessions must not revoke a row held by the exact
      // current transaction. Its own DML remains visible to the next read.
      for (const change of [
        `UPDATE canvas_organization_settings SET updated_at=updated_at+1 WHERE organization_id='tool-dispatch-org'`,
        `UPDATE "user" SET banned=1 WHERE id='reader'`,
        `UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'`,
      ]) {
        await fixture.admin.query('BEGIN');
        try {
          await fixture.admin.query("SET LOCAL lock_timeout='100ms'");
          await assert.rejects(fixture.admin.query(change), error => Boolean(error && typeof error === 'object'
            && Reflect.get(error, 'code') === '55P03'));
        } finally { await fixture.admin.query('ROLLBACK'); }
      }
      first.memberships.clear();
      assert.equal((await read(database, 'reader')).memberships.get('tool-dispatch-org')?.status, 'active',
        'Caller mutation cannot poison a subsequent current observation.');
      await database.run(`UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'`);
      assert.equal((await read(database, 'reader')).valid, false, 'Same-transaction revocation is freshly observed.');
    } finally { try { await database.run('ROLLBACK'); } finally { await database.close(); } }
    assert.deepEqual((await fixture.admin.query(authRows)).rows, baseline);
    assert.deepEqual(await rawSnapshot(async sql => (await fixture.admin.query(sql)).rows), rawBaseline);
    console.log(JSON.stringify({ suite: 'actor-membership-authority-postgres', variants: variants.length,
      fullAuthorityParity: true, unlockedStatements: 1, lockedStatements: 3,
      actualPeerLocks: 3, selfRevocationObserved: true, fixtureRestored: true,
      rawScalarTypesPreserved: true, rawRowsXminAndTypesRestored: true, actualActorAccountParity: true }));
  });
  completed = true;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
