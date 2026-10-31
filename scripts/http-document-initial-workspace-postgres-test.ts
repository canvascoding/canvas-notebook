import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

// Real initialized workspaces and PostgreSQL scalar results, followed by the
// genuine cookie/session resolver. Only query observation is installed; no
// session, actor, positive policy result or database reply is substituted.
let complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

await withDocumentReadToolDispatchFixture(async h => {
  const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
  const { readInitializedPostgresWorkspaceForActor: sequential,
    readInitializedPostgresDocumentReadWorkspaceForActor: joint } = await import('../app/lib/workspaces/postgres-runtime');
  const { requireExistingSelectedRequestWorkspace, requireExistingDocumentReadRequestWorkspace } =
    await import('../app/lib/workspaces/request');
  const { measureDocumentDatabaseActivity } = await import('../app/lib/observability/document-operation-metrics');
  const reader = resolveWorkspaceActor({ id: 'reader', email: 'reader@dispatch.test', role: 'user' });
  const owner = resolveWorkspaceActor({ id: 'owner', email: 'owner@dispatch.test', role: 'admin' });
  const absent = resolveWorkspaceActor({ id: 'absent', role: 'user' });
  await h.seed({ filePath: 'initial-facts.md', text: 'Keep native bytes 😀.\n' });
  const originalNative = await h.snapshot();
  const rawQuery = Client.prototype.query;
  const authority = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ['user', 'session', 'canvas_organization_settings', 'organization_user_permissions',
      'canvas_workspaces', 'canvas_workspace_members', 'canvas_project_members', 'team_memberships']) {
      if ((await h.admin.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation) {
        rows[table] = (await h.admin.query(`SELECT to_jsonb(t) AS body,xmin::text AS xmin FROM "${table}" t
          ORDER BY to_jsonb(t)::text,xmin::text`)).rows;
      }
    }
    return rows;
  };
  const observed = async <T>(operation: () => Promise<T>) => {
    const sql: string[] = [], backends = new Set<number>();
    let value: T | undefined, failure: unknown, measurement: unknown;
    assert.equal(Client.prototype.query, rawQuery);
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      if (this !== h.admin && !args.some(argument => typeof argument === 'function')) {
        sql.push(typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'text')));
        backends.add(Number(Reflect.get(this, 'processID')));
      }
      return Reflect.apply(rawQuery, this, args);
    };
    try {
      value = await measureDocumentDatabaseActivity('read', 'request', operation, current => { measurement = current; });
    } catch (error) { failure = error; }
    finally { Client.prototype.query = rawQuery; }
    const outcome = failure ? { error: failure instanceof Error ? failure.message : String(failure),
      code: typeof failure === 'object' ? Reflect.get(failure, 'code') : undefined } : { value };
    return { outcome, sql, backends, measurement: measurement as { checkouts: number; openConnectionsAtCompletion: number } };
  };
  let groups = 0;
  const compare = async (name: string, actor = reader, workspaceId = h.workspaceId, expectedJointSql = 1) => {
    const before = await authority(), nativeBefore = await h.snapshot();
    const old = await observed(() => sequential(actor, workspaceId));
    const current = await observed(() => joint(actor, workspaceId));
    assert.deepEqual(current.outcome, old.outcome, name);
    assert.equal(current.sql.length, expectedJointSql, name);
    assert.equal(current.backends.size, 1, 'Fallback must retain the same actual connection.');
    assert.equal(current.measurement.checkouts, 1);
    assert.equal(current.measurement.openConnectionsAtCompletion, 0);
    assert.equal(old.measurement.openConnectionsAtCompletion, 0);
    assert.deepEqual(await authority(), before, 'Reading never repairs or rewrites authorization rows.');
    assert.deepEqual(await h.snapshot(), nativeBefore, 'Reading preserves native bytes, identities and xmin.');
    console.log('HTTP_INITIAL_WORKSPACE_CASE', JSON.stringify({ name, oldSql: old.sql.length,
      jointSql: current.sql.length, sameResult: true, preserved: true }));
    groups++;
    return current.outcome;
  };
  await compare('organization');
  await compare('owner organization', owner);
  await compare('missing workspace', reader, 'missing-workspace');
  await compare('missing current user', absent);
  await h.admin.query(`INSERT INTO canvas_projects(id,organization_id,name,slug,status,created_at,updated_at)
    VALUES('initial-project','tool-dispatch-org','Initial project','initial-project','active',100,100)`);
  for (const type of ['personal', 'team', 'project']) {
    await h.admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,project_id,display_name,
      root_relative_path,status,created_at,updated_at) VALUES($1,'tool-dispatch-org',$2,'reader',$3,$2,$4,'active',100,100)`,
    [`initial-${type}`, type, type === 'project' ? 'initial-project' : null, `initial/${type}`]);
  }
  await h.admin.query(`INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
    VALUES('tool-dispatch-org','initial-team','reader','member','active',1,0,0,100,100)`);
  await h.admin.query(`INSERT INTO canvas_project_members(organization_id,project_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
    VALUES('tool-dispatch-org','initial-project','reader','member','active',1,0,0,100,100)`);
  for (const type of ['personal', 'team', 'project']) {
    await compare(type, reader, `initial-${type}`);
    await compare(`owner ${type}`, owner, `initial-${type}`);
  }
  await h.admin.query("UPDATE canvas_workspace_members SET status='disabled' WHERE workspace_id='initial-team'");
  await compare('revoked team membership', reader, 'initial-team');
  await h.admin.query("UPDATE canvas_project_members SET can_read=0 WHERE project_id='initial-project'");
  await compare('revoked project read', reader, 'initial-project');
  await h.admin.query("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [h.workspaceId]);
  await compare('archived workspace');
  await h.admin.query("UPDATE canvas_workspaces SET status='active' WHERE id=$1", [h.workspaceId]);
  await h.admin.query("UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'");
  await compare('revoked organization membership');
  await h.admin.query("UPDATE organization_user_permissions SET status='active' WHERE user_id='reader'");

  const configured = process.env.CANVAS_ORGANIZATION_ID;
  assert(configured);
  try {
    process.env.CANVAS_ORGANIZATION_ID = 'wrong-organization';
    await compare('organization mismatch');
    await compare('missing user takes precedence over organization mismatch', absent);
  } finally { process.env.CANVAS_ORGANIZATION_ID = configured; }

  // Optional tables are not queried by the old organization path. A missing
  // optional relation must use its original lookup sequence on one checkout.
  for (const table of ['canvas_workspace_members', 'canvas_project_members']) {
    await h.admin.query(`ALTER TABLE "${table}" RENAME TO "initial_original_${table}"`);
    try { await compare(`legacy missing ${table}`, reader, h.workspaceId, 6); }
    finally { await h.admin.query(`ALTER TABLE "initial_original_${table}" RENAME TO "${table}"`); }
  }
  await h.admin.query('ALTER TABLE canvas_organization_settings RENAME TO initial_original_organization');
  try {
    await h.admin.query('CREATE TABLE canvas_organization_settings (LIKE initial_original_organization INCLUDING ALL)');
    await compare('missing organization');
    await compare('missing user takes precedence over missing organization', absent);
    await h.admin.query('ALTER TABLE canvas_workspaces RENAME TO initial_original_workspaces');
    try { await compare('bootstrap error precedes missing workspace relation', reader, h.workspaceId, 3); }
    finally { await h.admin.query('ALTER TABLE initial_original_workspaces RENAME TO canvas_workspaces'); }
  } finally {
    await h.admin.query('DROP TABLE IF EXISTS canvas_organization_settings');
    await h.admin.query('ALTER TABLE initial_original_organization RENAME TO canvas_organization_settings');
  }
  // Independently bound IDs can work on an older mixed-type schema even when
  // the new column-to-column owner join cannot resolve an equality operator.
  const uuidOwner = '02c353f0-56c6-4ee1-8911-139ea1ae3490';
  await h.admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
    VALUES($1,'UUID owner','uuid-owner@dispatch.test',1,'admin',0,100,100)`, [uuidOwner]);
  await h.admin.query('ALTER TABLE canvas_organization_settings RENAME TO initial_original_organization');
  try {
    await h.admin.query('CREATE TABLE canvas_organization_settings (LIKE initial_original_organization INCLUDING ALL)');
    await h.admin.query('ALTER TABLE canvas_organization_settings ALTER COLUMN owner_user_id TYPE uuid USING owner_user_id::uuid');
    await h.admin.query(`INSERT INTO canvas_organization_settings
      SELECT (jsonb_populate_record(NULL::canvas_organization_settings,
        to_jsonb(t)||jsonb_build_object('owner_user_id',$1::text))).* FROM initial_original_organization t`, [uuidOwner]);
    await compare('legacy UUID owner and text user ID', reader, h.workspaceId, 6);
  } finally {
    await h.admin.query('DROP TABLE IF EXISTS canvas_organization_settings');
    await h.admin.query('ALTER TABLE initial_original_organization RENAME TO canvas_organization_settings');
  }
  await h.admin.query('DELETE FROM "user" WHERE id=$1', [uuidOwner]);
  await h.admin.query('ALTER TABLE "user" RENAME TO initial_original_users');
  try {
    await h.admin.query('CREATE TABLE "user" (LIKE initial_original_users INCLUDING ALL)');
    await h.admin.query('INSERT INTO "user" SELECT * FROM initial_original_users WHERE id<>$1', ['owner']);
    await compare('missing persisted owner');
  } finally {
    await h.admin.query('DROP TABLE IF EXISTS "user"');
    await h.admin.query('ALTER TABLE initial_original_users RENAME TO "user"');
  }
  await h.admin.query('ALTER TABLE organization_user_permissions ALTER COLUMN can_write_team_workspace TYPE numeric USING can_write_team_workspace::numeric');
  for (const value of ['1', '1.00000000000000000001', '0.99999999999999999999']) {
    await h.admin.query('UPDATE organization_user_permissions SET can_write_team_workspace=$1::numeric WHERE user_id=$2', [value, 'reader']);
    await compare(`raw numeric ${value}`);
  }
  await h.admin.query('ALTER TABLE organization_user_permissions ALTER COLUMN can_write_team_workspace TYPE integer USING can_write_team_workspace::integer');
  await h.admin.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE user_id='reader'");

  for (const code of ['08006', '57014']) {
    const before = await authority();
    const fault = await observed(async () => {
      const observingQuery = Client.prototype.query;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const result = Reflect.apply(observingQuery, this, args);
        if (this !== h.admin && typeof args[0] === 'string' && args[0].includes('AS initialized_actor_present')) {
          return Promise.resolve(result).then(() => { throw Object.assign(new Error('Initial facts acknowledgement lost'), { code }); });
        }
        return result;
      };
      try { return await joint(reader, h.workspaceId); }
      finally { Client.prototype.query = observingQuery; }
    });
    assert.deepEqual(fault.outcome, code === '08006'
      ? { code: 'postgres_unavailable', error: 'PostgreSQL is unavailable. Check its connection and credentials, then retry.' }
      : { code, error: 'Initial facts acknowledgement lost' });
    assert.equal(fault.sql.length, 1, 'Uncertain acknowledgement and timeout are never replayed through fallback.');
    assert.equal(fault.measurement.checkouts, 1);
    assert.equal(fault.measurement.openConnectionsAtCompletion, 0);
    assert.deepEqual(await authority(), before);
    groups++;
  }

  const token = (await h.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token;
  const cookie = (await serializeSignedCookie('better-auth.session_token', token, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
  const request = (selection = h.workspaceId, authenticated = true) => new NextRequest('http://localhost/api/documents/read', {
    method: 'POST', headers: { 'x-canvas-workspace-id': selection, ...(authenticated ? { cookie } : {}) },
  });
  for (const authenticated of [false, true]) for (const selection of [h.workspaceId, 'missing-workspace', 'legacy-personal']) {
    const before = await h.snapshot();
    const legacy = await requireExistingSelectedRequestWorkspace(request(selection, authenticated),
      { workspaceId: selection, permissions: 'canRead' });
    const current = await requireExistingDocumentReadRequestWorkspace(request(selection, authenticated), selection);
    assert.equal(current.response?.status, legacy.response?.status);
    assert.deepEqual(current.workspace, legacy.workspace);
    if (legacy.response) assert.deepEqual(await current.response!.json(), await legacy.response.json());
    else { assert.equal(current.session?.user.id, 'reader'); assert.equal(current.workspace?.workspaceId, h.workspaceId); }
    assert.deepEqual(await h.snapshot(), before);
    groups++;
  }
  assert.deepEqual(await h.snapshot(), originalNative);
  console.log('HTTP_INITIAL_WORKSPACE_PROOF', JSON.stringify({ passed: true, groups,
    noAuthorityOrNativeWritesDuringReads: true, scalarValuesPreserved: true, genuineCookieResolver: true }));
});
complete = true;
