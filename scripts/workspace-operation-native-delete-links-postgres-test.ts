import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceRequestPrincipalAccess } from '../app/lib/workspaces/request-principal';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceOperationNativeDeleteBatchPlan } from '../app/lib/files/workspace-operation-batch-contract';
import type { OriginalDeleteNativeLinkIntent, OriginalDeleteNativeLinkReceipt } from '../app/lib/files/workspace-operation-original-delete-links';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';

// Actual full-DDL PG18/Auth/Import/Store-claim/OriginalOwner integration.
// Each explicit group runs Personal/Cookie and Team/Bearer under the original
// 180s watchdog. No mock ACL, state loader, SQL result, claim or browser host.
type Group = 'success' | 'drift' | 'rollback' | 'ack';
const selectedGroup = (process.argv[2] ?? '--success').replace(/^--/u, '') as Group;
assert(['success', 'drift', 'rollback', 'ack'].includes(selectedGroup), 'Choose one explicit native-link Delete group.');
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
function describeFailure(error: unknown, depth = 0): unknown {
  if (depth > 4 || !(error instanceof Error)) return { name: 'unknown' };
  const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  const children = Object.getOwnPropertyDescriptor(error, 'errors')?.value;
  const stack = Object.getOwnPropertyDescriptor(error, 'stack')?.value;
  const frames = typeof stack === 'string' ? stack.split('\n').flatMap(line => {
    const match = /\/(app\/lib\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_./-]+):(\d+):(\d+)\)?$/u.exec(line);
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 4) : [];
  return { name: /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : 'unknown',
    code: typeof code === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(code) ? code : null, frames,
    ...(error instanceof AggregateError && Array.isArray(children)
      ? { errors: children.slice(0, 4).map(child => describeFailure(child, depth + 1)) } : {}),
    ...(cause instanceof Error ? { cause: describeFailure(cause, depth + 1) } : {}) };
}
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `native_delete_links_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^native_delete_links_[a-f0-9]{32}$/u);
  const organizationId = `native-delete-links-org-${crypto.randomUUID()}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-native-delete-links-')));
  const applicationName = `native-delete-links-fixture-${crypto.randomUUID()}`;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let created = false, controlConnected = false;
  let pool: { end(): Promise<void>; totalCount: number; waitingCount: number } | undefined;
  let cases = 0, fetches = 0;
  const checkouts = new Set<SqlConnection>();
  const digest = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    await control.connect(); controlConnected = true;
    const realm = (await control.query(`SELECT current_database() AS database,current_user AS role,
      d.oid::bigint AS oid,pg_get_userbyid(d.datdba) AS owner,current_setting('server_version_num') AS version
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(realm.database, 'canvas_notebook'); assert.equal(realm.role, decodeURIComponent(url.username));
    assert.equal(typeof realm.owner, 'string'); assert(realm.owner); assert(Number(realm.oid) > 0);
    assert.equal(Math.floor(Number(realm.version) / 10000), 18);
    assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS absent', [schema])).rows[0].absent, true);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: organizationId, CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
      CANVAS_TEST_NATIVE_TEXT_SESSION: '1' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = digest(keys.publicKey.export({ type: 'spki', format: 'der' }));
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: `native-delete-links-license-${crypto.randomUUID()}`,
      sub: process.env.CANVAS_INSTANCE_ID, instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook',
      plan: 'community', status: 'active', hostingMode: 'community', edition: 'team', licenseClass: 'commercial',
      licenseEnvironment: 'production', nonBillable: false, seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6,
      iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network/issuer is permitted in this isolated fixture.'); };
    const admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=${applicationName}` });
    admin.on('error', () => undefined); clients.add(admin); await admin.connect();
    const ownerRealm = async () => {
      const actual = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS oid,pg_backend_pid() AS backend`)).rows[0];
      assert.equal(actual.schema, schema); assert.equal(Number(actual.oid), Number(realm.oid));
      assert.deepEqual(actual.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']); return actual;
    };
    const adminBackend = (await ownerRealm()).backend;
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      assert.equal((await ownerRealm()).backend, adminBackend);
      const result = await admin.query(sql, values); await ownerRealm(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'real users, Team seats and Cookie/Bearer sessions';
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@starter.test',1,'admin',0,$1,$1),('member','Member','member@starter.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES($1,'owner','team',1,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES($1,'owner','owner','active',1,100,100),($1,'member','member','active',0,100,100)`, [organizationId]);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat',$1,'owner@starter.test','owner','owner','active',100,100,100,100),
      ('member-seat',$1,'member@starter.test','member','member','active',100,200,100,100)`, [organizationId]);
    await admin.query('INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES($1,100,100)', [organizationId]);
    const { personalWorkspaceRootRelativePath, organizationWorkspaceRootRelativePath } = await import('../app/lib/workspaces/contracts');
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,is_default,created_at,updated_at)
      VALUES($1,$2,'organization','Organization',$3,'active',1,100,100)`,
    [`organization-${crypto.randomUUID()}`, organizationId, organizationWorkspaceRootRelativePath(organizationId)]);
    for (const user of ['owner', 'member']) await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,
      root_relative_path,status,is_default,created_at,updated_at) VALUES($1,$2,'personal',$3,$3,$4,'active',1,100,100)`,
    [`personal-${crypto.randomUUID()}`, organizationId, user, personalWorkspaceRootRelativePath(user)]);
    const tokens = { owner: crypto.randomBytes(32).toString('hex'), member: crypto.randomBytes(32).toString('hex') };
    for (const user of ['owner', 'member'] as const) await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5)`, [`session-${user}`, tokens[user], user, now + 3600000, now]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    const { getLicenseStatus } = await import('../app/lib/license');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const { auth } = await import('../app/lib/auth');
    const { openDb } = await import('../app/lib/db');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { createPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { completeWorkspaceStarterDocumentInitialization } = await import('../app/lib/workspaces/starter-document-initialization');
    const { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection } = await import('../app/lib/workspaces/request-principal');
    const { persistPristineOriginalWorkspaceFileForWrite } = await import('../app/lib/collaboration/markdown-file-import-persistence');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const headers = async (workspaceId: string, cookie: boolean) => {
      const actual = new Headers({ 'x-canvas-workspace-id': workspaceId });
      if (cookie) actual.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens.owner, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else actual.set('authorization', `Bearer ${tokens.owner}`);
      return actual;
    };
    const request = async (workspaceId: string, cookie: boolean) => new NextRequest('http://localhost/api/files/create', {
      method: 'POST', headers: await headers(workspaceId, cookie),
    });
    const session = await auth.api.getSession({ headers: await headers('unused', true) });
    assert(session); assert.equal(session.user.id, 'owner'); const actor = resolveWorkspaceActor(session.user);
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); cases++; console.log(`Native Delete links PG18 passed: ${name}`);
    };
    const { loadCollaborationStateOnConnection } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedDocumentLinks, nativeLinkJsonProof } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { nativeLinkPreparedIntentProof } = await import('../app/lib/markdown/native-link-mutation-persistence');
    const { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } = await import('../app/lib/collaboration/agent-durability');
    const { stageWorkspaceLinkSourceAuthorityObservation } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { createRichMarkdownYDoc, richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { readRichDocumentJson } = await import('../app/lib/collaboration/rich-document');
    const { equivalentRichDocument } = await import('../app/lib/markdown/core/equivalence');
    const { prepareMarkdownFileImport } = await import('../app/lib/collaboration/markdown-file-import');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { buildWorkspaceOperationBatchPlan } = await import('../app/lib/files/workspace-operation-batch-plan');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { WorkspaceOperationBatchStore } = await import('../app/lib/files/workspace-operation-batch-store');
    const { executeWorkspaceOperationOriginalDelete: execute } = await import('../app/lib/files/workspace-operation-original-delete');
    const store = new WorkspaceOperationBatchStore();
    type NativeDocument = { path: string; fullPath: string; documentId: string; lineageId: string;
      state: PersistedCollaborationState };
    type Intent = { version: 2; batchId: string; planId: string; nativeLinks: OriginalDeleteNativeLinkIntent[];
      physical: { trashEntryId: string; trashRelativePath: string }; native: { documentId: string } };
    type Finished = { version: 2; batchId: string; intentDigest: string; trashEntryId: string;
      nativeLinks: OriginalDeleteNativeLinkReceipt[] };
    type Job = { claimed: NonNullable<Awaited<ReturnType<typeof store.claim>>>; workspace: WorkspaceContext;
      plan: WorkspaceOperationNativeDeleteBatchPlan; target: NativeDocument; sources: NativeDocument[]; keep: NativeDocument };
    const nativeState = async (documentId: string): Promise<PersistedCollaborationState> => {
      const connection = await openDb();
      try { const value = await loadCollaborationStateOnConnection(connection, documentId, true); assert(value); return value; }
      finally { await connection.close(); }
    };
    type CurrentActor = Pick<WorkspaceRequestPrincipalAccess, 'workspace' | 'userId' | 'sessionId'>;
    const currentAccess = async (workspaceId: string, cookie: boolean): Promise<CurrentActor> => withWorkspaceRequestPrincipal<CurrentActor>(await request(workspaceId, cookie), {
      // Request Principal supports read/write. Link changes require the real
      // write principal; actual delete rights are asserted below and checked
      // again by the genuine claimed-job policy in every OriginalOwner phase.
      workspaceId, permission: 'canWrite',
    }, async (principal): Promise<CurrentActor> => {
      const connection = await openDb(); let began = false, committed = false;
      try {
        await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); began = true;
        const result = await withWorkspaceRequestPrincipalOnConnection<CurrentActor>(connection, principal, async (access): Promise<CurrentActor> => {
          assert.equal(access.userId, 'owner'); assert.equal(access.sessionId, 'session-owner');
          assert.equal(access.workspace.workspaceId, workspaceId); assert.equal(access.workspace.permissions.canWrite, true);
          assert.equal(access.workspace.permissions.canDelete, true); await access.assertCurrent();
          return { workspace: access.workspace, userId: access.userId, sessionId: access.sessionId };
        });
        await connection.run('COMMIT'); committed = true; return result;
      } catch (error) {
        if (began && !committed) await connection.run('ROLLBACK'); throw error;
      } finally { await connection.close(committed ? undefined : new Error('Discarding failed genuine Principal phase.')); }
    });
    const importDocument = async (workspace: WorkspaceContext, cookie: boolean, filePath: string, content: string,
      representation: PersistedCollaborationState['representation']): Promise<NativeDocument> => {
      const fullPath = path.join(workspace.rootPath, filePath);
      const parent = path.dirname(fullPath); assert(fullPath.startsWith(`${workspace.rootPath}${path.sep}`));
      if (parent !== workspace.rootPath) await mkdir(parent, { recursive: true, mode: 0o700 });
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [workspace.workspaceId, filePath])).rows[0].count, 0);
      let fixtureContent = content;
      if (representation !== 'plain_text') {
        // Declared fixture text is serialized before any file/native identity
        // exists. Explicit rich import must retain those exact canonical bytes;
        // it may neither normalize input nor fall back to a different mode.
        const original = createRichMarkdownYDoc(content, representation);
        try {
          fixtureContent = richMarkdownFromYDoc(original);
          const canonical = createRichMarkdownYDoc(fixtureContent, representation);
          try { assert.equal(equivalentRichDocument(readRichDocumentJson(original), readRichDocumentJson(canonical)), true); }
          finally { canonical.destroy(); }
        } finally { original.destroy(); }
      } else assert.equal(fixtureContent, content);
      const fixtureBytes = Buffer.from(fixtureContent), prepared = prepareMarkdownFileImport(fixtureBytes, { representation });
      assert.equal(prepared.representation, representation); assert.equal(prepared.canonical, fixtureContent);
      assert.equal(prepared.sourceFallbackReason, undefined);
      // These are fixture bytes before any managed native identity exists. The
      // real authenticated importer creates registry, lineage, state and receipt.
      await writeFile(fullPath, fixtureBytes, { flag: 'wx', mode: 0o600 });
      const imported = await persistPristineOriginalWorkspaceFileForWrite(await request(workspace.workspaceId, cookie), {
        workspaceId: workspace.workspaceId, path: filePath, operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
        expectedTarget: { kind: 'absent' }, expectedFileVersion: filesystemFileVersion(await stat(fullPath)), initialRepresentation: representation,
      });
      assert.equal(imported.receipt.target.representation, representation);
      const registry = (await admin.query(`SELECT id,lineage_id,yjs_state_lifecycle,status FROM collaboration_documents
        WHERE workspace_id=$1 AND path=$2`, [workspace.workspaceId, filePath])).rows;
      assert.equal(registry.length, 1); assert.equal(registry[0].id, imported.receipt.target.documentId);
      assert.equal(registry[0].yjs_state_lifecycle, 'initialized'); assert.equal(registry[0].status, 'active');
      assert.equal(typeof registry[0].lineage_id, 'string'); assert(registry[0].lineage_id);
      const state = await nativeState(registry[0].id); assert.equal(state.status, 'active'); assert.equal(state.representation, representation);
      assert.equal(state.workspaceId, workspace.workspaceId); assert.equal(state.path, filePath);
      // Explicit owned projection-absence fixture; native bytes remain untouched.
      await unlink(fullPath); await assert.rejects(stat(fullPath), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      for (let directory = parent; directory !== workspace.rootPath; directory = path.dirname(directory)) {
        assert(directory.startsWith(`${workspace.rootPath}${path.sep}`));
        // Only exact empty generated ancestors; never recursively remove a
        // parent or touch an existing physical directory with another child.
        await rmdir(directory);
        await assert.rejects(stat(directory), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
      }
      return { path: filePath, fullPath, documentId: registry[0].id, lineageId: registry[0].lineage_id, state };
    };
    const freshJob = async (workspace: WorkspaceContext, cookie: boolean): Promise<Job> => {
      const suffix = crypto.randomUUID(), targetPath = selectedGroup === 'success'
        ? `registry-${suffix}/nested/target.md` : `target-${suffix}.md`, keepPath = `keep-${suffix}.md`;
      stage = `${selectedGroup}/${workspace.workspaceType}: target import`;
      const target = await importDocument(workspace, cookie, targetPath, '# Delete target\n\nExact native target.\n', 'tiptap_blocks');
      stage = `${selectedGroup}/${workspace.workspaceType}: keep import`;
      const keep = await importDocument(workspace, cookie, keepPath, '# Keep target\n\nIndependent document.\n', 'plain_text');
      const sources: NativeDocument[] = [];
      const representations: PersistedCollaborationState['representation'][] = selectedGroup === 'success'
        ? ['plain_text', 'tiptap_xml', 'tiptap_blocks'] : ['plain_text'];
      for (const representation of representations) {
        stage = `${selectedGroup}/${workspace.workspaceType}: source import ${representation}`;
        const source = await importDocument(workspace, cookie, `source-${representation}-${suffix}.md`,
          `# Source ${representation}\n\n[Remove target](${targetPath}) and [Keep target](${keepPath}).\n\nIndependent paragraph.\n`, representation);
        const links = inspectPersistedDocumentLinks(source.state); assert.equal(links.coverage.complete, true);
        assert.deepEqual(links.links.map(link => link.literal), [targetPath, keepPath]); sources.push(source);
      }
      stage = `${selectedGroup}/${workspace.workspaceType}: currentAccess`;
      const access = await currentAccess(workspace.workspaceId, cookie);
      stage = `${selectedGroup}/${workspace.workspaceType}: planner`;
      const plan = await buildWorkspaceOperationBatchPlan({ scope: { workspace: access.workspace, fileOptions: { workspace: access.workspace } },
        actions: [{ reviewId: crypto.randomUUID(), kind: 'delete', selections: [{ sourcePath: target.path }] }] });
      if (plan.version !== 2) assert.fail('A genuine native V2 plan is required.');
      assert.equal(plan.readiness, 'ready'); assert.deepEqual(plan.issues, []); assert.equal(plan.pathSteps.length, 1);
      assert.equal(plan.nativeTarget.documentId, target.documentId);
      if (selectedGroup === 'success') {
        for (const directory of [path.posix.dirname(targetPath), path.posix.dirname(path.posix.dirname(targetPath))]) {
          await assert.rejects(stat(path.join(workspace.rootPath, directory)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
          const entry: NativeNamespaceEntry | undefined = plan.sourceEvidence.stage.namespace.find(entry => entry.path === directory); assert(entry);
          assert.equal(entry.kind, 'directory');
          assert.equal(entry.identity, `registry-directory:${nativeLinkJsonProof({ workspaceId: workspace.workspaceId, path: directory })}`);
          assert.equal(entry.filesystemIdentity, null); assert.equal(entry.documentId, null); assert.equal(entry.lifecycleGeneration, null);
        }
      }
      const recipes = plan.nativeGraphPlan.steps.flatMap(step => step.linkIntents);
      assert.equal(recipes.length, sources.length);
      stage = `${selectedGroup}/${workspace.workspaceType}: createDirect`;
      const created = await store.createDirect({ batchId: crypto.randomUUID(), plan, authorization: { mode: 'direct',
        actorUserId: access.userId, actorId: access.userId, actorType: 'user', actorSessionId: access.sessionId,
        actorDisplayName: 'Genuine native-link Delete actor', requestHash: digest(crypto.randomBytes(32)),
        jobScope: captureWorkspaceOperationJobScope(access.workspace) } });
      stage = `${selectedGroup}/${workspace.workspaceType}: claim`;
      const claimed = await store.claim(crypto.randomUUID()); assert(claimed); assert.equal(claimed.batchId, created.batchId);
      return { claimed, workspace: access.workspace, plan, target, sources, keep };
    };
    const intentRow = async (job: Job) => (await admin.query(`SELECT intent_text,intent_digest FROM workspace_file_operation_delete_intents
      WHERE batch_id=$1`, [job.claimed.batchId])).rows[0] as { intent_text: string; intent_digest: string } | undefined;
    const receiptRow = async (job: Job) => (await admin.query(`SELECT receipt_text,receipt_digest,intent_digest FROM workspace_file_operation_delete_receipts
      WHERE batch_id=$1`, [job.claimed.batchId])).rows[0] as { receipt_text: string; receipt_digest: string; intent_digest: string } | undefined;
    const linksRows = async (job: Job) => (await admin.query(`SELECT * FROM collaboration_native_link_mutation_receipts
      WHERE document_id=ANY($1::text[]) ORDER BY document_id`, [job.sources.map(source => source.documentId)])).rows;
    const readIntent = async (job: Job) => {
      const row = await intentRow(job); assert(row); assert.equal(digest(Buffer.from(row.intent_text)), row.intent_digest);
      const value = JSON.parse(row.intent_text) as Intent; assert.equal(value.version, 2); assert.equal(value.batchId, job.claimed.batchId);
      assert.equal(value.planId, job.plan.planId); assert.equal(value.native.documentId, job.target.documentId);
      assert.equal(value.nativeLinks.length, job.sources.length);
      for (const item of value.nativeLinks) {
        const source = job.sources.find(source => source.documentId === item.prepared.source.documentId); assert(source);
        assert.equal(item.prepared.source.path, source.path); assert.equal(item.prepared.before.documentSequence, source.state.documentSequence);
        const { updateBase64, ...prepared } = item.prepared;
        assert.equal(Buffer.from(updateBase64, 'base64').toString('base64'), updateBase64);
        assert.equal(item.binding.authorizedPreparedProof, nativeLinkPreparedIntentProof({ ...prepared, update: Buffer.from(updateBase64, 'base64') }));
        assert.equal(item.binding.actorUserId, 'owner'); assert.equal(item.binding.actorId, 'owner'); assert.equal(item.binding.actorType, 'user');
        assert.equal(item.binding.actorSessionId, 'session-owner');
      }
      return { row, value };
    };
    const foreignEdit = async (source: NativeDocument, suffix: string) => {
      // Deliberate real foreign-SQL fault in our owned schema. A legitimate
      // managed writer correctly cannot enter beneath the retained Owner fence.
      const state = await nativeState(source.documentId); assert.equal(state.representation, 'plain_text');
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, state.yjsState); const text = document.getText('content'); text.insert(text.length, `\n\n${suffix}`);
        const changed = await admin.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,
          document_sequence=document_sequence+1,persisted_at=$3 WHERE document_id=$4 AND document_sequence=$5 AND status='active' RETURNING document_id`,
        [Buffer.from(Y.encodeStateAsUpdate(document)), Buffer.from(Y.encodeStateVector(document)), Math.max(Date.now(), state.persistedAt + 1), source.documentId, state.documentSequence]);
        assert.equal(changed.rows.length, 1);
      } finally { document.destroy(); }
      return nativeState(source.documentId);
    };
    const tracked = (job: Job, fault: Group | 'none' = 'none') => {
      const observation = { opens: 0, closes: 0, injected: false, intentText: '', intentDigest: '',
        sawLinkReceiptBeforeRollback: false, committedObserved: false, discarded: false, intentAlreadyCompleted: false };
      const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
      return { observation, open: async (): Promise<SqlConnection> => {
        const raw = await openDb(); observation.opens++; checkouts.add(raw);
        let forwardedQueries = 0, diagnosticQueries = 0;
        type PhaseOutcome = 'committed' | 'rolled-back' | 'begin-error' | 'commit-error' | 'rollback-error' | 'superseded' | 'close-requested';
        const phases: Array<{ index: number; beginKind: 'plain' | 'read-committed-read-write' | 'other'; milliseconds: number;
          forwardedQueries: number; outcome: PhaseOutcome }> = [];
        let activePhase: { index: number; beginKind: 'plain' | 'read-committed-read-write' | 'other'; start: number; queriesBefore: number } | undefined;
        const finishPhase = (outcome: PhaseOutcome) => {
          if (!activePhase) return;
          phases.push({ index: activePhase.index, beginKind: activePhase.beginKind, milliseconds: Math.round(performance.now() - activePhase.start),
            forwardedQueries: forwardedQueries - activePhase.queriesBefore, outcome });
          activePhase = undefined;
        };
        const afterQuery = async (sql: string) => {
          if (fault !== 'rollback' || observation.injected || !/\bINSERT\s+INTO\s+(?:"[^"]+"\.)?"?collaboration_native_link_mutation_receipts\b/iu.test(sql)) return;
          diagnosticQueries++;
          const onB = await raw.get('SELECT count(*)::int AS count FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [job.sources[0].documentId]) as { count: number };
          assert.equal(Number(onB.count), 1); assert.equal((await linksRows(job)).length, 0, 'The uncommitted link receipt must be invisible to the actual other backend.');
          diagnosticQueries++;
          const stateOnB = await raw.get('SELECT document_sequence FROM collaboration_yjs_states WHERE document_id=$1', [job.sources[0].documentId]) as { document_sequence: number };
          assert.equal(Number(stateOnB.document_sequence), job.sources[0].state.documentSequence + 1);
          observation.sawLinkReceiptBeforeRollback = true; observation.injected = true; fail('FIXTURE_NATIVE_DELETE_LINK_RECEIPT_ROLLBACK');
        };
        return { get: async (sql, values) => { forwardedQueries++; const result = await raw.get(sql, values); await afterQuery(sql); return result; },
          all: async (sql, values) => { forwardedQueries++; const result = await raw.all(sql, values); await afterQuery(sql); return result; },
          run: async (sql, values) => {
            const begins = /^BEGIN\b/iu.test(sql), commits = /^COMMIT\s*$/iu.test(sql), rollsBack = /^ROLLBACK\s*$/iu.test(sql);
            if (begins) {
              finishPhase('superseded');
              activePhase = { index: phases.length + 1, beginKind: /^BEGIN\s*$/iu.test(sql) ? 'plain'
                : /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE\s*$/iu.test(sql) ? 'read-committed-read-write' : 'other',
              start: performance.now(), queriesBefore: forwardedQueries };
            }
            forwardedQueries++;
            let result: Awaited<ReturnType<SqlConnection['run']>>;
            try { result = await raw.run(sql, values); }
            catch (error) {
              if (begins || commits || rollsBack) finishPhase(begins ? 'begin-error' : commits ? 'commit-error' : 'rollback-error');
              throw error;
            }
            // Measure the actual database boundary before any observer query or
            // deliberate ACK-loss injection; no SQL result is substituted.
            if (commits || rollsBack) finishPhase(commits ? 'committed' : 'rolled-back');
            await afterQuery(sql);
            if (/^COMMIT\s*$/iu.test(sql)) {
              const saved = await intentRow(job), complete = await receiptRow(job);
              if (saved && !observation.intentText) {
                const captured = await readIntent(job); observation.intentText = captured.row.intent_text; observation.intentDigest = captured.row.intent_digest;
                observation.intentAlreadyCompleted = !!complete;
                assert.equal((await linksRows(job)).length, complete ? job.sources.length : 0);
                if (fault === 'drift') {
                  assert.equal(complete, undefined);
                  await foreignEdit(job.sources[0], 'Foreign source edit after committed B1.'); observation.injected = true;
                }
              }
              if (fault === 'ack' && complete && !observation.injected) {
                assert.equal((await linksRows(job)).length, job.sources.length);
                assert.equal((await nativeState(job.target.documentId)).status, 'archived');
                observation.committedObserved = true; observation.injected = true; fail('FIXTURE_NATIVE_DELETE_B2_ACK_LOST');
              }
            }
            return result;
          }, close: async error => { observation.closes++; assert.equal(observation.closes, 1); observation.discarded = !!error;
            checkouts.delete(raw); finishPhase('close-requested');
            let closeReturned = false;
            try { await raw.close(error); closeReturned = true; }
            finally {
              console.log('Native Delete links private Owner-B metrics:', JSON.stringify({ group: selectedGroup,
                workspaceType: job.workspace.workspaceType, fault, forwardedQueries, diagnosticQueries, phases,
                discardRequested: !!error, closeReturned }));
            } } };
      } };
    };
    const invoke = async (job: Job, adapter = tracked(job)) => {
      try {
        stage = `${selectedGroup}/${job.workspace.workspaceType}: withClaim`;
        return await store.withClaim(job.claimed, async claim => {
          stage = `${selectedGroup}/${job.workspace.workspaceType}: execute`;
          const result = await execute(claim, adapter.open);
          assert.equal(result.version, 2); assert(result.nativeLinks); assert.equal(result.nativeLinks.length, job.sources.length);
          const completedActions = 1 + result.nativeLinks.length;
          stage = `${selectedGroup}/${job.workspace.workspaceType}: finishClaim`;
          const completed = await store.finishClaim(job.claimed, { status: 'applied', phase: 'complete', completedActions,
            trashEntryIds: [result.trashEntryId] });
          assert(completed); assert.equal(completed.status, 'applied');
          assert.equal(completed.completedActions, completedActions); assert.equal(completed.totalActions, completedActions); return result;
        });
      } finally { assert.equal(adapter.observation.opens, 1); assert.equal(adapter.observation.closes, 1); }
    };
    const markRecovery = async (job: Job) => {
      const changed = await store.finishClaim(job.claimed, { status: 'needs_recovery', phase: 'recovery', errorCode: 'FIXTURE_EXPECTED_FAILURE' });
      assert(changed); assert.equal(changed.status, 'needs_recovery');
    };
    const resume = async (job: Job): Promise<Job> => {
      const queued = await store.enqueue({ batchId: job.claimed.batchId, planId: job.plan.planId, userId: 'owner', displayName: 'Original native-link actor', action: 'resume' });
      assert.equal(queued.status, 'queued'); const claimed = await store.claim(crypto.randomUUID()); assert(claimed);
      assert.equal(claimed.batchId, job.claimed.batchId); assert.deepEqual(claimed.plan, job.claimed.plan);
      assert.deepEqual(claimed.authorization, job.claimed.authorization); return { ...job, claimed };
    };
    const assertRolledBack = async (job: Job, expectedSource = job.sources[0].state) => {
      assert.equal(await receiptRow(job), undefined); assert.equal((await linksRows(job)).length, 0);
      const target = await nativeState(job.target.documentId); assert.deepEqual(target, job.target.state);
      assert.deepEqual(await nativeState(job.sources[0].documentId), expectedSource);
      assert.deepEqual(await nativeState(job.keep.documentId), job.keep.state);
      const registry = (await admin.query('SELECT status FROM collaboration_documents WHERE id=$1', [job.target.documentId])).rows[0]; assert.equal(registry.status, 'active');
      assert.equal((await admin.query('SELECT status FROM file_collaboration_lineages WHERE id=$1', [job.target.lineageId])).rows[0].status, 'active');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM workspace_trash_entries WHERE workspace_id=$1', [job.workspace.workspaceId])).rows[0].count, 0);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM workspace_file_operation_delete_trash_receipts WHERE batch_id=$1', [job.claimed.batchId])).rows[0].count, 0);
      await assert.rejects(stat(job.target.fullPath), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
    };
    const assertApplied = async (job: Job, result: Awaited<ReturnType<typeof execute>>, adapter: ReturnType<typeof tracked>, changedAfterCompletion = false) => {
      const captured = await readIntent(job); assert.equal(captured.row.intent_text, adapter.observation.intentText);
      assert.equal(captured.row.intent_digest, adapter.observation.intentDigest);
      const complete = await receiptRow(job); assert(complete); assert.equal(digest(Buffer.from(complete.receipt_text)), complete.receipt_digest);
      assert.equal(result.receiptDigest, complete.receipt_digest); assert.equal(complete.intent_digest, captured.row.intent_digest);
      const value = JSON.parse(complete.receipt_text) as Finished; assert.equal(value.version, 2); assert.equal(value.nativeLinks.length, job.sources.length);
      assert.deepEqual(result.nativeLinks, value.nativeLinks);
      assert.equal(value.trashEntryId, captured.value.physical.trashEntryId); assert.equal(result.trashEntryId, value.trashEntryId);
      const rows = await linksRows(job); assert.equal(rows.length, job.sources.length);
      for (const item of captured.value.nativeLinks) {
        const source = job.sources.find(source => source.documentId === item.prepared.source.documentId); assert(source);
        const sql = rows.find(row => row.document_id === source.documentId); assert(sql);
        const receipt = value.nativeLinks.find(receipt => receipt.source.documentId === source.documentId); assert(receipt);
        assert.equal(sql.operation_id, item.prepared.operationId); assert.equal(sql.authorized_prepared_proof, item.binding.authorizedPreparedProof);
        assert.equal(sql.actor_user_id, item.binding.actorUserId); assert.equal(sql.actor_id, item.binding.actorId);
        assert.equal(sql.actor_type, item.binding.actorType); assert.equal(sql.actor_session_id, item.binding.actorSessionId);
        assert.equal(sql.request_id, item.binding.requestId); assert.equal(sql.request_hash, item.binding.requestHash);
        assert.equal(Number(sql.before_sequence), item.prepared.before.documentSequence); assert.equal(Number(sql.after_sequence), item.prepared.before.documentSequence + 1);
        assert.equal(sql.before_state_proof, item.prepared.before.stateProof); assert.equal(sql.after_state_proof, item.prepared.after.stateProof);
        assert.deepEqual(sql.before_state_vector, Buffer.from(item.prepared.before.stateVector, 'base64'));
        assert.deepEqual(sql.after_state_vector, Buffer.from(item.prepared.after.stateVector, 'base64'));
        assert.deepEqual(sql.after_state_snapshot, Buffer.from(receipt.afterStateSnapshotBase64, 'base64'));
        assert.equal(`yjs-snapshot-sha256-v1:${digest(sql.after_state_snapshot)}`, item.prepared.after.stateProof);
        assert.deepEqual(receipt.source, item.prepared.source); assert.deepEqual(receipt.binding, item.binding);
        assert.deepEqual(receipt.before, item.prepared.before); assert.deepEqual(receipt.inverseRecipes, item.prepared.inverseRecipes);
        const state = await nativeState(source.documentId), inventory = inspectPersistedDocumentLinks(state);
        assert.equal(state.status, 'active'); assert.equal(state.lifecycleGeneration, source.state.lifecycleGeneration);
        assert.equal(state.documentSequence, source.state.documentSequence + (changedAfterCompletion ? 2 : 1));
        assert.deepEqual(inventory.links.map(link => link.literal), [job.keep.path]);
        if (!changedAfterCompletion) {
          const document = new Y.Doc();
          try {
            Y.applyUpdate(document, state.yjsState);
            const actualSnapshot = captureAgentStateSnapshot(document, Y); assert(actualSnapshot);
            assert.deepEqual(Buffer.from(actualSnapshot), sql.after_state_snapshot);
          } finally { document.destroy(); }
          assert.deepEqual(Buffer.from(state.stateVector), sql.after_state_vector);
        } else {
          assert.equal(persistedUpdateIncludesAgentSnapshot(state.yjsState, sql.after_state_snapshot, Y), true,
            'The later actual source state must still contain the committed operation snapshot, including its deletions.');
        }
      }
      const target = await nativeState(job.target.documentId); assert.equal(target.status, 'archived');
      assert.equal(target.lifecycleGeneration, job.target.state.lifecycleGeneration + 1);
      assert.equal(target.documentSequence, job.target.state.documentSequence); assert.deepEqual(Buffer.from(target.yjsState), Buffer.from(job.target.state.yjsState));
      assert.deepEqual(Buffer.from(target.stateVector), Buffer.from(job.target.state.stateVector));
      assert.equal((await admin.query('SELECT status FROM collaboration_documents WHERE id=$1', [job.target.documentId])).rows[0].status, 'archived');
      assert.equal((await admin.query('SELECT status,trash_entry_id FROM file_collaboration_lineages WHERE id=$1', [job.target.lineageId])).rows[0].trash_entry_id, value.trashEntryId);
      const trash = (await admin.query('SELECT * FROM workspace_trash_entries WHERE id=$1', [value.trashEntryId])).rows[0]; assert(trash);
      assert.equal(trash.status, 'trashed'); assert.equal(trash.workspace_id, job.workspace.workspaceId); assert.equal(trash.original_path, job.target.path);
      assert.equal(JSON.parse(trash.metadata_json).payloadKind, 'native_archive');
      const trashReceipt = (await admin.query('SELECT intent_digest FROM workspace_file_operation_delete_trash_receipts WHERE batch_id=$1', [job.claimed.batchId])).rows;
      assert.equal(trashReceipt.length, 1); assert.equal(trashReceipt[0].intent_digest, captured.row.intent_digest);
      assert.deepEqual(await nativeState(job.keep.documentId), job.keep.state);
      const batch = await store.get(job.claimed.batchId); assert(batch); assert.equal(batch.status, 'applied');
      assert.equal(batch.phase, 'complete'); assert.equal(batch.completedActions, 1 + job.sources.length);
      assert.equal(batch.totalActions, 1 + job.sources.length);
      if (selectedGroup === 'success') {
        const observation = await stageWorkspaceLinkSourceAuthorityObservation(job.workspace);
        assert.equal(observation.stage.coverage.complete, true, JSON.stringify(observation.stage.coverage.gaps));
        for (const directory of [path.posix.dirname(job.target.path), path.posix.dirname(path.posix.dirname(job.target.path))]) {
          assert.equal(observation.stage.namespace.some(entry => entry.path === directory), false,
            'Actual collection must remove empty registry-only ancestors after deleting their final native descendant.');
          await assert.rejects(stat(path.join(job.workspace.rootPath, directory)), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
        }
      }
    };
    for (const [workspaceType, cookie] of [['personal', true], ['team', false]] as const) {
      await check(`${workspaceType}/${cookie ? 'Cookie' : 'Bearer'}: ${selectedGroup}`, async () => {
        const workspace = await createPostgresWorkspaceForActor(actor, { type: workspaceType, name: `Native links ${selectedGroup} ${workspaceType} ${crypto.randomUUID()}` });
        assert.equal(workspace.workspaceType, workspaceType);
        const initialized = await completeWorkspaceStarterDocumentInitialization(await request(workspace.workspaceId, cookie), workspace.workspaceId, { requireIntent: true });
        assert.equal(initialized.status, 'completed');
        const job = await freshJob(workspace, cookie), adapter = tracked(job, selectedGroup);
        if (selectedGroup === 'success') {
          const result = await invoke(job, adapter); await assertApplied(job, result, adapter);
          assert.equal(job.sources.length, 3); assert.equal(adapter.observation.injected, false);
        } else if (selectedGroup === 'drift') {
          await assert.rejects(invoke(job, adapter), error => !(error instanceof assert.AssertionError) && !!error && typeof error === 'object'
            && ['NATIVE_SOURCE_EVIDENCE_CHANGED', 'NATIVE_DELETE_PLAN_CHANGED', 'NATIVE_LINK_SOURCE_CHANGED', 'ORIGINAL_DELETE_CHANGED'].includes(String(Reflect.get(error, 'code'))));
          assert.equal(adapter.observation.injected, true); assert(adapter.observation.intentText);
          const changed = await nativeState(job.sources[0].documentId); assert.equal(changed.documentSequence, job.sources[0].state.documentSequence + 1);
          await assertRolledBack(job, changed); await markRecovery(job);
          const saved = await readIntent(job); assert.equal(saved.row.intent_text, adapter.observation.intentText);
          assert.equal(saved.row.intent_digest, adapter.observation.intentDigest);
        } else if (selectedGroup === 'rollback') {
          await assert.rejects(invoke(job, adapter), { code: 'FIXTURE_NATIVE_DELETE_LINK_RECEIPT_ROLLBACK' });
          assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.sawLinkReceiptBeforeRollback, true);
          await assertRolledBack(job); await markRecovery(job);
          const retry = await resume(job), retried = tracked(retry); const result = await invoke(retry, retried);
          // The new Owner must reuse B1's exact durable bytes rather than rebuilding CRDT client identities.
          assert.equal(retried.observation.intentText, adapter.observation.intentText); await assertApplied(retry, result, retried);
        } else {
          await assert.rejects(invoke(job, adapter), { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED' });
          assert.equal(adapter.observation.injected, true); assert.equal(adapter.observation.committedObserved, true);
          assert.equal(adapter.observation.discarded, true); const originalReceipt = await receiptRow(job); assert(originalReceipt);
          await markRecovery(job); const peer = await foreignEdit(job.sources[0], 'Independent peer edit after completed B2.');
          const retry = await resume(job), retried = tracked(retry), result = await invoke(retry, retried);
          // The actual retry's first committed policy phase observes the original
          // immutable intent and completion; no expected value is supplied to it.
          assert.equal(retried.observation.intentAlreadyCompleted, true);
          assert.equal(retried.observation.intentText, adapter.observation.intentText);
          assert.equal(retried.observation.intentDigest, adapter.observation.intentDigest);
          assert.deepEqual(await receiptRow(retry), originalReceipt); assert.deepEqual(await nativeState(job.sources[0].documentId), peer);
          await assertApplied(retry, result, retried, true);
        }
      });
    }
    assert.equal(cases, 2); assert.equal(fetches, 0);
    console.log(`Native Delete links PG18 ${selectedGroup}: ${cases}/2 genuine Personal/Team/Cookie/Bearer/Import/Claim/Owner families passed; no browser or general file-action acceptance claimed.`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const connection of checkouts) { checkouts.delete(connection); await connection.close(new Error('Discarding leaked native Delete-link fixture checkout.')); }
    try { if (pool) { await pool.end(); assert.equal(pool.totalCount, 0); assert.equal(pool.waitingCount, 0); } }
    finally {
      try { for (const client of clients) { await client.end(); clients.delete(client); } }
      finally {
        try {
          if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); }
          if (controlConnected) assert.equal(Number((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count), 0);
        } finally {
          try { await control.end(); } finally {
            await rm(dataRoot, { recursive: true, force: true });
            await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
          }
        }
      }
    }
    console.log('Native Delete links fixture cleanup: own schema removed, zero owned clients/checkouts, DATA removed.');
  }
}
void runSqlFixture({ label: `workspace-operation-native-delete-links-postgres-test:${selectedGroup}`, operation: async () => {
  try { await main(); }
  catch (error) {
    // Never print a PostgreSQL query, parameter payload, private URL or token.
    console.error('Owned native Delete links fixture failed:', JSON.stringify({ stage, failure: describeFailure(error) }));
    throw new Error('Native Delete links fixture failed after owned cleanup.');
  }
},
  successMessage: `Native Delete links ${selectedGroup} genuine PG18 integration and owned cleanup passed; no UI/global acceptance.` });
