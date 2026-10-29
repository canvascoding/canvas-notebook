import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Genuine Request Principal and real held PG transaction. Every expected user,
// including disabled permission-only and suspended membership users, is tested
// with an incompatible peer SELECT FOR UPDATE (table SHARE alone cannot pass).
async function workspacePrincipalUserLocksPostgresTest(): Promise<void> {
  const baselineOnly = process.env.CANVAS_PRINCIPAL_USER_LOCKS_BASELINE === '1';
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
    const principal = await import('../app/lib/workspaces/request-principal');
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const tables = ['user', 'session', 'canvas_organization_settings', 'team_memberships', 'team_membership_sync_state',
      'organization_user_permissions', 'canvas_workspaces', 'canvas_projects', 'canvas_workspace_members', 'canvas_project_members'];
    const snapshot = async () => {
      const data: Record<string, unknown> = {};
      for (const name of tables) data[name] = (await h.admin.query(`SELECT to_jsonb(r) AS body,xmin::text AS xmin
        FROM ${quote(h.schema)}.${quote(name)} r ORDER BY to_jsonb(r)::text,xmin::text`)).rows;
      data.columns = (await h.admin.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attname`, [h.schema, tables])).rows;
      data.constraints = (await h.admin.query(`SELECT c.oid,c.conrelid,c.conname,c.confrelid,c.convalidated,
        c.condeferrable,c.conenforced FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname=$1 ORDER BY c.oid`, [h.schema])).rows;
      return data;
    };
    await h.admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('unreferenced-lock-control','Unreferenced banned user','unreferenced@user-locks.test',1,'user',1,100,100)`);
    const expected = new Set(['owner', 'member']);
    let seeded = 0, groups = 0, peerDenials = 0, peerUnreferencedAllowed = 0;
    const evidence: unknown[] = [];
    const blockedByShare = async (userId: string) => {
      await h.admin.query('BEGIN');
      try {
        await assert.rejects(h.admin.query(`SELECT id FROM ${quote(h.schema)}."user" WHERE id=$1 FOR UPDATE NOWAIT`, [userId]),
          error => { assert.equal((error as { code?: string }).code, '55P03'); return true; });
        peerDenials++;
      } finally { await h.admin.query('ROLLBACK'); }
    };
    const run = async (permission: 'canRead' | 'canWrite', kind: 'text' | 'domain-id' | 'numeric-zero' | 'numeric-tiny' | 'peer-lock'
      | 'invalid-flag-workspace-peer' | 'invalid-flag-membership-peer',
      peerUser?: string) => {
      const before = await snapshot();
      const ordered = [...expected].sort((a,b) => Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')));
      const legacy: unknown[] = [], batches: Array<{ requested: unknown; rows: Record<string, unknown>[] }> = [];
      let entered = false, failure: unknown;
      const rollbackControl = new Error('Positive compatibility observation; roll back actual fixture DDL.');
      const tiny = '0.' + '0'.repeat(70) + '1';
      try {
        const result = await principal.withWorkspaceRequestPrincipal(await h.request(h.destination, 'member'),
          { workspaceId: h.destination.workspaceId, permission }, p => executeLifecycleTransaction({
            openConnection: openDb, execute: async database => {
              await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE');
              if (kind === 'domain-id') {
                // Rebuild genuine FKs around the real compatible parent type,
                // then let the unchanged schema/trigger guards validate them.
                const fks = await database.all(`SELECT c.conname,child.relname,pg_get_constraintdef(c.oid) AS definition
                  FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
                  WHERE c.contype='f' AND c.confrelid=$1::regclass ORDER BY child.relname,c.conname`,
                [`${quote(h.schema)}."user"`]) as Array<{ conname: string; relname: string; definition: string }>;
                assert(fks.length > 0);
                for (const fk of fks) await database.run(`ALTER TABLE ${quote(h.schema)}.${quote(fk.relname)} DROP CONSTRAINT ${quote(fk.conname)}`);
                await database.run(`CREATE DOMAIN ${quote(h.schema)}.user_lock_id_domain AS text`);
                await database.run(`ALTER TABLE ${quote(h.schema)}."user" ALTER COLUMN id TYPE ${quote(h.schema)}.user_lock_id_domain USING id::text`);
                for (const fk of fks) await database.run(`ALTER TABLE ${quote(h.schema)}.${quote(fk.relname)} ADD CONSTRAINT ${quote(fk.conname)} ${fk.definition}`);
              }
              if (kind === 'numeric-zero' || kind === 'numeric-tiny') {
                await database.run(`ALTER TABLE ${quote(h.schema)}."user" ALTER COLUMN banned TYPE numeric USING banned::numeric`);
                if (kind === 'numeric-tiny') await database.run(`UPDATE ${quote(h.schema)}."user" SET banned=$2::numeric WHERE id=$1`,
                  ['lock-account-0000', tiny]);
              }
              if(kind==='invalid-flag-workspace-peer'||kind==='invalid-flag-membership-peer') {
                await database.run(`UPDATE ${quote(h.schema)}."user" SET banned=2 WHERE id=$1`,['lock-account-0000']);
              }
              return h.withProbe(async event => {
                const sql = event.text.replace(/\s+/gu, ' ').trim();
                if (sql.startsWith('SELECT id,banned FROM ') && sql.endsWith('WHERE id=$1 FOR SHARE NOWAIT')) legacy.push(event.values[0]);
                if (sql.includes('AS requested_user_id') && sql.includes('AS lock_user_found')) batches.push({
                  requested: structuredClone(event.values[0]), rows: structuredClone(event.result.rows),
                });
              }, () => principal.withWorkspaceRequestPrincipalOnConnection(database, p, async access => {
                entered = true; assert.equal(access.workspace.workspaceId, h.destination.workspaceId);
                assert.equal(kind === 'numeric-tiny' || kind === 'peer-lock' || kind === 'invalid-flag-workspace-peer'
                  || kind === 'invalid-flag-membership-peer', false, 'A real lock/flag fault cannot enter the consumer.');
                await access.assertCurrent();
                if (kind === 'text') {
                  for (const userId of ordered) await blockedByShare(userId);
                  // Prove the peer is not simply blocked by a table lock and
                  // that an unrelated user has not joined the selected set.
                  await h.admin.query('BEGIN');
                  try {
                    assert.equal((await h.admin.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE NOWAIT',
                      ['unreferenced-lock-control'])).rows.length, 1);
                    peerUnreferencedAllowed++;
                  } finally { await h.admin.query('ROLLBACK'); }
                }
                if (kind === 'domain-id' || kind === 'numeric-zero') throw rollbackControl;
                return 'actual-locked-principal';
              }));
            }, recoverCommitted: async () => { throw new Error('User-lock test never replays a domain operation.'); },
          }));
        assert.equal(result, 'actual-locked-principal');
      } catch (error) { failure = error; }
      const deny = kind === 'numeric-tiny' || kind === 'peer-lock' || kind === 'invalid-flag-workspace-peer' || kind === 'invalid-flag-membership-peer';
      if (deny) {
        assert.equal(entered, false); assert(failure);
        assert.equal((failure as { code?: string }).code, kind === 'peer-lock' || kind === 'invalid-flag-membership-peer'
          ? 'PRINCIPAL_BUSY' : 'PRINCIPAL_SCOPE_CHANGED');
      } else if (kind === 'domain-id' || kind === 'numeric-zero') {
        assert.equal(entered, true); assert.equal(failure, rollbackControl);
      } else { if (failure) throw failure; assert(entered); }
      if (!deny) {
        const scalar = baselineOnly || kind === 'domain-id';
        assert.equal(legacy.length, scalar ? ordered.length : 0);
        assert.equal(batches.length, scalar ? 0 : 1);
        if (scalar) assert.deepEqual(legacy, ordered);
        else {
          assert.deepEqual(batches[0].requested, ordered); assert.equal(batches[0].rows.length, ordered.length);
          for (const [index,row] of batches[0].rows.entries()) {
            assert.equal(row.requested_user_id, ordered[index]); assert.equal(row.lock_user_found, true);
            assert.equal(row.banned, kind === 'numeric-zero' ? '0' : 0, 'Raw NUMERIC stays a driver string.');
          }
        }
      } else if (kind === 'numeric-tiny' && !baselineOnly) {
        assert.equal(batches.length, 1);
        const raw = batches[0].rows.find(row => row.requested_user_id === 'lock-account-0000'); assert(raw);
        assert.equal(raw.banned, tiny, 'A tiny nonzero NUMERIC flag cannot round into an allowed zero.');
      }
      if (kind !== 'peer-lock') assert.deepEqual(await snapshot(), before,
        'Actual scope controls and rolled-back DDL preserve authority rows/xmin, column types and original FK OIDs.');
      groups++; evidence.push({ permission, kind, users: ordered.length, legacyReads: legacy.length, batchReads: batches.length,
        entered, denied: deny, peerUser: peerUser ?? null });
    };
    for (const count of [2,32,200]) {
      while (expected.size < count) {
        const index = seeded++, userId = `lock-account-${String(index).padStart(4,'0')}`; expected.add(userId);
        await h.admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
          VALUES($1,'Inactive lock user',$2,1,'user',0,100,100)`, [userId, `${userId}@user-locks.test`]);
        if (index % 2 === 0) await h.admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,created_at,updated_at)
          VALUES($1,$2,$3,$4,'member','suspended',100,100)`, [`membership-${userId}`,h.source.organizationId,`${userId}@user-locks.test`,userId]);
        else await h.admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
          VALUES($1,$2,'member','disabled',0,100,100)`, [h.source.organizationId,userId]);
      }
      for (const permission of ['canRead','canWrite'] as const) await run(permission, 'text');
    }
    for (const permission of ['canRead','canWrite'] as const) {
      await run(permission, 'domain-id'); await run(permission, 'numeric-zero'); await run(permission, 'numeric-tiny');
      for (const userId of ['lock-account-0000','lock-account-0001']) {
        const before = await snapshot(); await h.admin.query('BEGIN');
        try {
          assert.equal((await h.admin.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE NOWAIT', [userId])).rows.length, 1);
          await run(permission, 'peer-lock', userId);
        } finally { await h.admin.query('ROLLBACK'); }
        assert.deepEqual(await snapshot(), before);
      }
      for (const kind of ['invalid-flag-workspace-peer','invalid-flag-membership-peer'] as const) {
        const before=await snapshot();await h.admin.query('BEGIN');
        try {
          if(kind==='invalid-flag-workspace-peer')assert.equal((await h.admin.query('SELECT id FROM canvas_workspaces WHERE id=$1 FOR UPDATE NOWAIT',[h.destination.workspaceId])).rows.length,1);
          else assert.equal((await h.admin.query('SELECT id FROM team_memberships WHERE id=$1 FOR UPDATE NOWAIT',['owner-seat'])).rows.length,1);
          await run(permission,kind);
        }finally{await h.admin.query('ROLLBACK');}
        assert.deepEqual(await snapshot(),before);
      }
    }
    assert.equal(groups, 20); assert.equal(peerDenials, 2 * (2+32+200)); assert.equal(peerUnreferencedAllowed, 6);
    // The actual phase has completed and disposed before a peer can lock again.
    await h.admin.query('BEGIN');
    try { assert.equal((await h.admin.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE NOWAIT', ['lock-account-0000'])).rows.length, 1); }
    finally { await h.admin.query('ROLLBACK'); }
    console.log(JSON.stringify({ principalUserLocks: true, baselineOnly, groups, actualPeerRowLockDenials: peerDenials,
      unrelatedPeerRowLocksAllowed: peerUnreferencedAllowed, originalRowsTypesAndConstraintOidsPreserved: true, evidence }));
  });
}

let complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
await workspacePrincipalUserLocksPostgresTest();
complete = true;
