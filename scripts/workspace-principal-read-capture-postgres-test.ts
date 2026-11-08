import assert from 'node:assert/strict';
import { Client } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', groups = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { NextRequest } = await import('next/server');
    const principal = await import('../app/lib/workspaces/request-principal');
    const { requireExistingSelectedRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { openDb } = await import('../app/lib/db');
    const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
    const { SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    await fixture.seed({ filePath: 'protected-principal-read.md', text: '# Preserve this native document\n' });
    const baseline = await fixture.snapshot();
    let token = '';
    const refreshSession = async () => {
      await fixture.restoreReaderSession();
      token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
    };
    await refreshSession();
    const request = () => new NextRequest('http://localhost/api/files/collaboration/session', {
      headers: { authorization: `Bearer ${token}`, 'x-canvas-workspace-id': fixture.workspaceId },
    });
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++; console.log(`Principal read capture passed: ${name}`);
    };
    const observe = () => undefined;
    const capture = <T>(operation: Parameters<typeof principal.withWorkspaceRequestPrincipalOriginalOrigin<T>>[3],
      permission: 'canRead' | 'canWrite' = 'canRead', workspaceId = fixture.workspaceId) =>
      principal.withWorkspaceRequestPrincipalOriginalOrigin(request(), { workspaceId, permission }, observe, operation);
    let heldConsumers = 0;
    const held = (p: Parameters<typeof principal.withWorkspaceRequestPrincipalOnConnection>[1]) =>
      executeLifecycleTransaction({ openConnection: openDb, execute: database =>
        principal.withWorkspaceRequestPrincipalOnConnection(database, p, async access => {
          heldConsumers++;
          await access.assertCurrent();
          return access.workspace;
        }), recoverCommitted: async () => { throw new Error('A lost commit cannot confirm fresh read access.'); } });
    await check('fresh read capture has one workspace snapshot and preserves held authorization', async () => {
      const expected = await requireExistingSelectedRequestWorkspace(request(),
        { workspaceId: fixture.workspaceId, permissions: 'canRead' });
      assert.equal(expected.response, null);
      await capture(held); // Warm genuine authentication before counting.
      const queries: string[] = [], original = Client.prototype.query;
      let capturing = true;
      Client.prototype.query = function (this: Client, ...args: Parameters<typeof original>) {
        const first: unknown = args[0];
        if (capturing) queries.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
        return Reflect.apply(original, this, args);
      } as typeof original;
      try {
        const workspace = await capture(async p => { capturing = false; return held(p); });
        assert.deepEqual(workspace, expected.workspace);
      } finally { Client.prototype.query = original; }
      console.log(`Principal read capture SQL statements=${queries.length}`);
      console.log('Principal read capture query families', JSON.stringify(queries.map(sql => ({
        command: sql.trim().match(/^\w+/u)?.[0],
        tables: [...sql.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_][a-z0-9_]*)/giu)].map(match => match[1]),
        workspaceSnapshot: sql.includes('initialized_actor_present'), realmCapture: sql.includes('AS database') && sql.includes('schema_oid'),
      }))));
      // Four real auth/seat statements, one current workspace snapshot,
      // one fresh Principal license read and one original-realm capture.
      assert(queries.length > 0 && queries.length <= 7,
        `Fresh read capture used ${queries.length} statements; budget is 7 including genuine authentication, license and realm capture`);
      assert(!queries.some(sql => /\bjwks\b/iu.test(sql)), 'A session read must not issue an unused JWT');
      assert.equal(queries.filter(sql => sql.includes('initialized_actor_present')).length, 1);
      assert(!queries.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql.trim())));
      assert.deepEqual(await fixture.snapshot(), baseline);
    });
    await check('read-only membership cannot capture a writer or a foreign workspace', async () => {
      let entered = false;
      await assert.rejects(capture(async () => { entered = true; }, 'canWrite'),
        error => error instanceof principal.WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_ACCESS_DENIED');
      assert.equal(entered, false);
      await assert.rejects(capture(held, 'canRead', 'foreign-workspace'),
        error => error instanceof principal.WorkspaceRequestPrincipalError && error.code === 'PRINCIPAL_ACCESS_DENIED');
    });
    await check('ban, seat suspension, archive and retired credentials deny a fresh capture', async () => {
      for (const [revoke, restore] of [
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
        ["UPDATE canvas_workspaces SET status='archived' WHERE id=$1", "UPDATE canvas_workspaces SET status='active' WHERE id=$1"],
      ]) {
        await refreshSession();
        const values = revoke.includes('$1') ? [fixture.workspaceId] : [];
        await fixture.admin.query(revoke, values);
        try { await assert.rejects(capture(held), error => error instanceof principal.WorkspaceRequestPrincipalError); }
        finally { await fixture.admin.query(restore, values); }
        await refreshSession(); await capture(held);
      }
      await refreshSession();
      await fixture.admin.query("DELETE FROM session WHERE id='reader-session'");
      await assert.rejects(capture(held), error => error instanceof principal.WorkspaceRequestPrincipalError
        && error.code === 'PRINCIPAL_AUTH_REVOKED');
      await refreshSession(); await capture(held);
    });
    await check('a successful outer capture cannot authorize a later revoked held phase', async () => {
      const denied = (error: unknown) => error instanceof principal.WorkspaceRequestPrincipalError
        || error instanceof SeatLimitGuardError && error.code === 'SEAT_MEMBERSHIP_REQUIRED';
      for (const [revoke, restore] of [
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
        ["UPDATE canvas_workspaces SET status='archived' WHERE id=$1", "UPDATE canvas_workspaces SET status='active' WHERE id=$1"],
        ["UPDATE session SET expires_at=1 WHERE id='reader-session'", "UPDATE session SET expires_at=4102444800000 WHERE id='reader-session'"],
      ]) {
        await refreshSession();
        const before = heldConsumers;
        await assert.rejects(capture(async p => {
          const values = revoke.includes('$1') ? [fixture.workspaceId] : [];
          await fixture.admin.query(revoke, values);
          try { await assert.rejects(held(p), denied); }
          finally { await fixture.admin.query(restore, values); }
        }), denied);
        assert.equal(heldConsumers, before, 'Revocation after capture must prevent the held consumer from entering');
      }
      assert.deepEqual(await fixture.snapshot(), baseline);
    });
  });
  console.log(`Principal read capture: ${groups} groups passed with actual authentication and PostgreSQL`);
}
main().catch(error => {
  console.error(`Principal read capture failed at ${stage}: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
