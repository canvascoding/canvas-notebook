import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { NativeWorkspaceOperationBackupSelection, WorkspaceOperationBackup } from '../app/lib/files/workspace-operation-backup';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
let completed = false;
process.once('beforeExit', () => {
  if (!completed) { console.error('Native-only backup fixture did not complete.', { stage }); process.exitCode = 1; }
});
const watchdog = setTimeout(() => {
  console.error('Native-only backup fixture exceeded its bounded deadline.', { stage }); process.exit(1);
}, 180_000);
const hash = (bytes: string | Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await fs.stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await fs.readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `native_only_backup_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^native_only_backup_[a-f0-9]{32}$/u);
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'canvas-native-only-backup-'));
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, options: '-c statement_timeout=15000', connectionTimeoutMillis: 5000 });
  const clients = new Set<Client>(); let created = false, cases = 0, transactions = 0;
  let pool: { end: () => Promise<void> } | undefined;
  const workspaceId = `native-baseline-${crypto.randomUUID()}`;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=native-only-backup-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'principal-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS; delete process.env.NEXT_PHASE;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = hash(keys.publicKey.export({ type: 'spki', format: 'der' }));
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'baseline-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('Network is forbidden in this isolated baseline fixture.'); };
    stage = 'actual owned-schema global DDL';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      assert.equal((await admin.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
      return admin.query(sql, values);
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@baseline.test',1,'admin',0,$1,$1),('member','Member','member@baseline.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@baseline.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@baseline.test','member','member','active',100,200,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'principal-org','organization','Organization','organizations/principal-org/shared','active',100,100)`, [workspaceId]);
    for (const userId of ['owner', 'member']) await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES($1,'principal-org','personal',$2,$2,$3,'active',100,100)`, [`personal-${userId}`, userId, `users/${userId}/workspace`]);
    const tokens: Record<string, string> = {};
    for (const userId of ['owner', 'member']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens[userId] = token;
      await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)`,
        [`session-${userId}`, token, userId, now + 3600000, now]);
    }
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    assert.equal((await getLicenseStatus()).licensed, true);
    const { captureNativeWorkspaceOperationBackup: capture, restoreWorkspaceOperationBackup: restore,
      listWorkspaceOperationBackups: list } = await import('../app/lib/files/workspace-operation-backup');
    const { deserializeNativeRecoveryPayload } = await import('../app/lib/collaboration/native-document-recovery');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { readNativeWorkspaceRecoveryRecords } = await import('../app/lib/collaboration/workspace-native-recovery');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { createPlainTextYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { nativeTableWidthFixture } = await import('./helpers/rich-markdown-projection-fixtures');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { GET: info } = await import('../app/api/files/info/route');
    const root = path.join(dataRoot, 'organizations/principal-org/shared'); await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    const request = (userId = 'owner') => {
      const headers = new Headers({ 'x-canvas-workspace-id': workspaceId });
      headers.set('authorization', `Bearer ${tokens[userId]}`);
      return new NextRequest('http://localhost/api/files/info', { headers });
    };
    const cookieRequest = async (userId = 'member') => {
      const actual = request(userId);
      actual.headers.delete('authorization');
      actual.headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens[userId], process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      return actual;
    };
    const selectedWorkspace = await requireRequestWorkspace(request(), { workspaceId, permissions: 'canWrite' });
    assert(!selectedWorkspace.response); const workspace = selectedWorkspace.workspace;
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++; console.log(`Native-only backup passed: ${name}`); };
    const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === value;
    const direct = (client: Client): SqlConnection => ({ get: async (sql, values) => (await client.query(sql, values)).rows[0],
      all: async (sql, values) => (await client.query(sql, values)).rows, run: async (sql, values) => (await client.query(sql, values)).rows,
      close: () => assert.fail('Caller retains this owned verification connection.') });
    const factory = (options: { beforeOpen?: () => Promise<void>; afterRead?: () => Promise<void>; wrongRealm?: boolean } = {}) => {
      const events: string[] = [];
      return { events, openConnection: async (): Promise<SqlConnection> => {
        await options.beforeOpen?.(); const client = await ownClient(); let active = false, closed = false;
        if (options.wrongRealm) await client.query('SET search_path=pg_catalog');
        const query = async (sql: string, values?: unknown[]) => {
          assert(!closed); const command = sql.trim(); const result = await client.query(sql, values);
          if (/^BEGIN$/u.test(command)) { active = true; transactions++; events.push('begin'); }
          if (/^(?:COMMIT|ROLLBACK)$/u.test(command)) { if (active) transactions--; active = false; events.push(command.toLowerCase()); }
          if (/^SELECT \* FROM collaboration_yjs_states\b/u.test(command)) { events.push('persisted-state-row'); await options.afterRead?.(); }
          return result.rows;
        };
        return { get: async (sql, values) => (await query(sql, values))[0], all: query, run: query,
          close: async () => { if (closed) return; closed = true; await endClient(client); if (active) transactions--; active = false; events.push('closed'); } };
      } };
    };
    const seed = async (filePath: string, representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text') => {
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      const doc = representation === 'plain_text' ? createPlainTextYDoc('Persisted original\n') : nativeTableWidthFixture(representation, 'Original table 😀');
      if (representation !== 'plain_text') assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)); doc.destroy();
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,7,100,0,NULL,NULL,NULL,'crlf',1,0,'active')`, [documentId, workspaceId, filePath, representation, update, vector]);
      const response = await info(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({ path: filePath })}`, { headers: request().headers }));
      assert.equal(response.status, 200);
      const expectedTarget: NativeWorkspaceOperationBackupSelection['expectedTarget'] = (await response.json()).data.metadataTarget;
      assert.deepEqual(expectedTarget, { version: 1, kind: 'native_file', workspaceId, path: filePath, documentId, lifecycleGeneration: 1 });
      const selection: NativeWorkspaceOperationBackupSelection = { workspaceId, path: filePath, operationId: `baseline-${crypto.randomUUID()}`, expectedTarget };
      const identity = { documentId, lineageId, workspaceId, organizationId: 'principal-org', path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1 };
      return { selection, identity, update, vector };
    };
    const folder = (backup: WorkspaceOperationBackup) => path.join(dataRoot, '.workspace-operation-backups',
      hash(JSON.stringify(['organization', 'principal-org', workspaceId])), backup.backupId);
    const readBackup = async (backup: WorkspaceOperationBackup) => {
      const bytes = await fs.readFile(path.join(folder(backup), 'native.bin'));
      assert.equal(hash(bytes), backup.nativePayload?.sha256); assert.equal(bytes.byteLength, backup.nativePayload?.sizeBytes);
      return { bytes, records: deserializeNativeRecoveryPayload(bytes) };
    };
    const inventory = async () => (await list({ workspace })).backups.map(item => item.backupId).sort();
    const advance = async (item: Awaited<ReturnType<typeof seed>>) => {
      const doc = new Y.Doc(); Y.applyUpdate(doc, item.update);
      doc.getText(item.identity.representation === 'plain_text' ? 'content' : 'frontmatter').insert(0,
        item.identity.representation === 'plain_text' ? 'Later durable content\n' : '---\nupdated: true\n---\n');
      try { await admin.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=8,persisted_at=200 WHERE document_id=$3`,
        [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), item.identity.documentId]); }
      finally { doc.destroy(); }
    };

    await check('real bearer/cookie CanRead members capture Plain/XML/Blocks with missing or stale Markdown', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        const item = await seed(`${representation}.md`, representation);
        if (representation === 'tiptap_xml') await fs.writeFile(path.join(root, item.selection.path), '# Obsolete physical projection\n');
        const owned = factory(); const before = (await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [item.identity.documentId])).rows[0];
        const open = fs.open; const forbidden = path.join(realRoot, item.selection.path);
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          assert.equal(transactions, 0, 'No filesystem descriptor work under native B.');
          assert.notEqual(args[0], forbidden, 'The physical Markdown projection is never a capture source.');
          return open(...args);
        }) as typeof fs.open;
        let backup: WorkspaceOperationBackup;
        try { backup = await capture(representation === 'tiptap_xml' ? await cookieRequest() : request('member'), item.selection, owned); }
        finally { fs.open = open; }
        assert.equal(owned.events.filter(event => event === 'persisted-state-row').length, 1);
        assert.equal(owned.events.at(-1), 'closed'); assert.equal(backup.version, 2); assert.equal(backup.nativePayload?.documentCount, 1);
        assert.deepEqual(backup.entries, [{ type: 'native_document', path: '.' }]); assert.equal(backup.sizeBytes, 0);
        assert.equal(backup.fileCount, 1); assert.equal(backup.directoryCount, 0);
        const stored = await readBackup(backup); const record = stored.records[0];
        assert.equal(stored.records.length, 1); assert.equal(record.lineageId, item.identity.lineageId);
        assert.equal(record.state.documentId, item.identity.documentId); assert.equal(record.state.documentSequence, 7);
        assert(Buffer.from(record.state.yjsState).equals(item.update)); assert(Buffer.from(record.state.stateVector).equals(item.vector));
        assert.equal(record.state.hasBom, true); assert.equal(record.state.newlineStyle, 'crlf');
        assert.deepEqual((await admin.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [item.identity.documentId])).rows[0], before);
        await assert.rejects(fs.lstat(path.join(folder(backup), 'payload')), { code: 'ENOENT' });
        if (representation === 'tiptap_xml') assert.equal(await fs.readFile(path.join(root, item.selection.path), 'utf8'), '# Obsolete physical projection\n');
        else await assert.rejects(fs.lstat(path.join(root, item.selection.path)), { code: 'ENOENT' });
      }
    });
    await check('active real room ownership and a later durable sequence cannot relabel captured bytes', async () => {
      const item = await seed('active-room.md', 'tiptap_blocks'); const ownerClient = await ownClient();
      const owner = await createCollaborationRoomOwnerSession(ownerClient);
      const fence = await owner.acquire(item.identity);
      try {
        let read = false;
        const backup = await capture(request(), item.selection, factory({ afterRead: async () => { assert.equal(read, false); read = true; await advance(item); } }));
        assert.equal(read, true); const captured = await readBackup(backup);
        assert.equal(captured.records[0].state.documentSequence, 7); assert(Buffer.from(captured.records[0].state.yjsState).equals(item.update));
        assert.equal(Number((await admin.query('SELECT document_sequence FROM collaboration_yjs_states WHERE document_id=$1', [item.identity.documentId])).rows[0].document_sequence), 8);
        await owner.assertActive(fence);
      } finally { await owner.close(); clients.delete(ownerClient); }
    });
    await check('idempotent operation keeps original payload/hash/sequence and never adopts another lifecycle', async () => {
      const item = await seed('repeat.md'); const backup = await capture(request(), item.selection, factory());
      const original = await readBackup(backup); const manifest = await fs.readFile(path.join(folder(backup), 'manifest.json'));
      await advance(item);
      assert.deepEqual(await capture(request(), item.selection, factory()), backup);
      assert((await fs.readFile(path.join(folder(backup), 'manifest.json'))).equals(manifest));
      assert((await readBackup(backup)).bytes.equals(original.bytes));
      await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [item.identity.documentId]);
      await assert.rejects(capture(request(), item.selection, factory()), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
      const fresh = { ...item.selection, expectedTarget: { ...item.selection.expectedTarget, lifecycleGeneration: 2 } };
      await assert.rejects(capture(request(), fresh, factory()), code('SOURCE_CHANGED'));
      assert((await readBackup(backup)).bytes.equals(original.bytes));
    });
    await check('exact outer spaces and renamed suffixes remain separate, native restoration preserves native-only recovery', async () => {
      const item = await seed(' Note (2).md ', 'tiptap_blocks'); const other = await seed('Note (2).md', 'tiptap_blocks');
      await assert.rejects(capture(request(), { ...item.selection, expectedTarget: { ...item.selection.expectedTarget, documentId: other.identity.documentId } }, factory()), code('SIDE_EFFECT_WRITER_SCOPE_CHANGED'));
      const backup = await capture(request(), item.selection, factory()); assert.equal(backup.originalPath, ' Note (2).md ');
      const neighbor = await seed('Recovered (3).md');
      await fs.writeFile(path.join(root, neighbor.selection.path), 'Trimmed physical neighbor must stay unchanged\n');
      const recovered = await restore({ workspace, backupId: backup.backupId, targetPath: ' Recovered (3).md ', actorUserId: 'owner', actorSessionId: 'session-owner', operationId: 'restore-native-only' });
      assert.equal(recovered.restoredPath, ' Recovered (3).md ');
      assert.equal(recovered.recoveryMode, 'native_complete'); assert.equal(recovered.collaborationInitialized, true);
      const records = await readNativeWorkspaceRecoveryRecords(direct(admin), workspace, recovered.restoredPath);
      assert.equal(records.length, 1); assert.notEqual(records[0].state.documentId, item.identity.documentId);
      assert.notEqual(records[0].lineageId, item.identity.lineageId);
      const semantic = (content: unknown) => JSON.parse(JSON.stringify(content, (key, value) => key === 'id' ? undefined : value));
      assert.deepEqual(semantic(authoritativeNativeCollaborationSnapshot(records[0].state).content),
        semantic(authoritativeNativeCollaborationSnapshot((await readBackup(backup)).records[0].state).content));
      await assert.rejects(fs.lstat(path.join(root, recovered.restoredPath)), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(root, neighbor.selection.path), 'utf8'), 'Trimmed physical neighbor must stay unchanged\n');
      assert((await admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [neighbor.identity.documentId])).rows[0].yjs_state.equals(neighbor.update));
      const defaultRequest = { workspace, backupId: backup.backupId, actorUserId: 'owner', actorSessionId: 'session-owner', operationId: 'native-default-existing' };
      await assert.rejects(restore(defaultRequest), 'The original active document remains a native collision.');
      assert.equal((await admin.query('SELECT path FROM collaboration_documents WHERE id=$1', [item.identity.documentId])).rows[0].path, ' Note (2).md ');
    });
    await check('exact native restore still rejects physical collisions, unsafe parents and symbolic links', async () => {
      const item = await seed('restore-guards.md'); const backup = await capture(request(), item.selection, factory());
      const physical = path.join(root, ' blocked.md '); await fs.writeFile(physical, 'Existing physical owner\n');
      const link = path.join(root, ' parent-link '); await fs.symlink(realRoot, link);
      const leaf = path.join(root, ' leaf-link.md '); await fs.symlink(physical, leaf);
      const recordsBefore = Number((await admin.query('SELECT count(*) AS count FROM collaboration_documents')).rows[0].count);
      for (const [index, targetPath] of [' blocked.md ', ' parent-link / leaf.md ', ' leaf-link.md ', 'missing-parent/ new.md ', '../escape.md'].entries()) {
        await assert.rejects(restore({ workspace, backupId: backup.backupId, targetPath, actorUserId: 'owner', actorSessionId: 'session-owner', operationId: `restore-guard-${index}` }));
      }
      assert.equal(await fs.readFile(physical, 'utf8'), 'Existing physical owner\n');
      assert.equal(Number((await admin.query('SELECT count(*) AS count FROM collaboration_documents')).rows[0].count), recordsBefore);
    });
    await check('accessor/extra/physical/mismatched targets reject before a bootstrap connection', async () => {
      const item = await seed('invalid-target.md'); const before = await inventory();
      const variants = [{ ...item.selection, workspace }, { ...item.selection, expectedTarget: { ...item.selection.expectedTarget, extra: true } },
        { ...item.selection, expectedTarget: { version: 1, kind: 'filesystem', workspaceId, path: item.selection.path, fileVersion: '1:2:3:4:5', entryType: 'file' } },
        { ...item.selection, path: `${item.selection.path} ` }, { ...item.selection, expectedTarget: { ...item.selection.expectedTarget, lifecycleGeneration: 0 } },
        Object.defineProperty({ ...item.selection }, 'operationId', { enumerable: true, get: () => assert.fail('Input accessor must not run.') })];
      for (const variant of variants) { const owned = factory(); await assert.rejects(capture(request(), variant as NativeWorkspaceOperationBackupSelection, owned), code('INVALID_BACKUP')); assert.deepEqual(owned.events, []); }
      assert.deepEqual(await inventory(), before);
    });
    await check('genuine missing/revoked membership, backend scope drift and corrupt native state produce no backup', async () => {
      const item = await seed('fail-closed.md'); const before = await inventory();
      await assert.rejects(capture(new NextRequest('http://localhost/api/files/info'), item.selection, factory()));
      try { await assert.rejects(capture(request('member'), item.selection, factory({ beforeOpen: async () => {
        await admin.query("UPDATE organization_user_permissions SET status='disabled' WHERE user_id='member'");
      } }))); }
      finally { await admin.query("UPDATE organization_user_permissions SET status='active' WHERE user_id='member'"); }
      await assert.rejects(capture(request(), item.selection, factory({ wrongRealm: true })), code('PRINCIPAL_SCOPE_CHANGED'));
      await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1 WHERE document_id=$2', [Buffer.from([255]), item.identity.documentId]);
      await assert.rejects(capture(request(), item.selection, factory()));
      assert.deepEqual(await inventory(), before);
    });
    await check('existing Exclusive admission prevents capture without a physical fallback', async () => {
      const item = await seed('admission-busy.md'); const before = await inventory(); const competitor = await ownClient();
      try { await competitor.query('SELECT pg_advisory_lock($1::bigint)', [collaborationAdmissionLockKey(workspaceId)]);
        await assert.rejects(capture(request(), item.selection, factory()), code('SIDE_EFFECT_WRITER_BUSY'));
      } finally { await endClient(competitor); }
      assert.deepEqual(await inventory(), before);
    });
    await check('kernel remains held after B closes until native fsync/publication ends; failed publication cleans only its temp', async () => {
      const item = await seed('publication.md'); const before = await inventory();
      const resource = new AsyncResource('native-backup-kernel-peer'); const rename = fs.rename; const open = fs.open;
      const events: string[] = []; let peer: Promise<void> | undefined; let entered = false; let injected = false;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        if (typeof args[0] === 'string' && args[0].endsWith('/native.bin') && typeof args[1] === 'number' && (args[1] & constants.O_WRONLY)) {
          assert.equal(transactions, 0); events.push('native-file-after-b-close');
        }
        return open(...args);
      }) as typeof fs.open;
      fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
        if (typeof args[0] === 'string' && args[0].includes('.tmp-')) {
          assert.equal(transactions, 0); injected = true;
          peer = resource.runInAsyncScope(() => withWorkspaceMutationLock(workspaceId, async () => { entered = true; events.push('peer-entered'); }));
          await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(entered, false, 'Publication still owns the kernel.');
          throw new Error('Injected owned native publication failure');
        }
        return rename(...args);
      }) as typeof fs.rename;
      try { await assert.rejects(capture(request(), item.selection, factory()), /Injected owned native publication failure/u); }
      finally { fs.rename = rename; fs.open = open; await peer; resource.emitDestroy(); }
      assert.equal(injected, true); assert.equal(entered, true); assert.deepEqual(events, ['native-file-after-b-close', 'peer-entered']);
      assert.deepEqual(await inventory(), before);
      const scope = path.join(dataRoot, '.workspace-operation-backups', hash(JSON.stringify(['organization', 'principal-org', workspaceId])));
      assert.equal((await fs.readdir(scope)).some(name => name.includes('.tmp-')), false);
      assert.equal((await capture(request(), item.selection, factory())).entries[0].type, 'native_document');
    });
    await check('renamed backup remains unconfirmed until a retry actually syncs its scope without replaying original bytes', async () => {
      const item = await seed('scope-fsync-recovery.md');
      const scope = path.join(await fs.realpath(dataRoot), '.workspace-operation-backups', hash(JSON.stringify(['organization', 'principal-org', workspaceId])));
      const backupId = `opb-${hash(JSON.stringify(['organization', 'principal-org', workspaceId, item.selection.operationId, item.selection.path]))}`;
      const destination = path.join(scope, backupId); const open = fs.open;
      let deny = true, attempts = 0, confirmed = 0;
      fs.open = (async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === scope && typeof args[1] === 'number' && (args[1] & constants.O_DIRECTORY)) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            attempts++;
            if (deny) throw Object.assign(new Error('Injected scope fsync failure after successful rename'), { code: 'EIO' });
            await sync(); confirmed++;
          };
        }
        return handle;
      }) as typeof fs.open;
      try {
        await assert.rejects(capture(request(), item.selection, factory()), /Injected scope fsync failure/u);
        assert.equal(attempts, 1); assert.equal(confirmed, 0); assert.equal((await fs.lstat(destination)).isDirectory(), true);
        const manifest = await fs.readFile(path.join(destination, 'manifest.json'));
        const native = await fs.readFile(path.join(destination, 'native.bin'));
        const backup = JSON.parse(manifest.toString('utf8')) as WorkspaceOperationBackup;
        assert.equal(backup.backupId, backupId); assert.equal(hash(native), backup.nativePayload?.sha256);
        assert.equal(deserializeNativeRecoveryPayload(native)[0].state.documentSequence, 7);
        await advance(item);
        await assert.rejects(capture(request(), item.selection, factory()), /Injected scope fsync failure/u);
        assert.equal(attempts, 2); assert.equal(confirmed, 0);
        assert((await fs.readFile(path.join(destination, 'manifest.json'))).equals(manifest));
        assert((await fs.readFile(path.join(destination, 'native.bin'))).equals(native));
        deny = false;
        assert.deepEqual(await capture(request(), item.selection, factory()), backup);
        assert.equal(attempts, 3); assert.equal(confirmed, 1, 'Existing-success requires an actual successful scope fsync.');
        assert((await fs.readFile(path.join(destination, 'manifest.json'))).equals(manifest));
        assert((await fs.readFile(path.join(destination, 'native.bin'))).equals(native));
        const records = deserializeNativeRecoveryPayload(native);
        assert.equal(records[0].state.documentSequence, 7); assert(Buffer.from(records[0].state.yjsState).equals(item.update));
      } finally { fs.open = open; }
    });
    assert.equal(fetches, 0); assert.equal(transactions, 0);
    console.log(`Native-only Backup PG18: ${cases} real Auth/Team/PG/FS matrix families passed; durable native-only V2 recovery without Markdown export.`);
  } finally {
    globalThis.fetch = originalFetch;
    try { if (pool) await pool.end(); }
    finally { try { for (const client of clients) await client.end(); }
      finally { try { if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); } }
        finally { await control.end(); await fs.rm(dataRoot, { recursive: true, force: true });
          for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment); } } }
  }
}
main().then(() => { completed = true; clearTimeout(watchdog); }, error => {
  console.error('Native-only Backup fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null, message: error instanceof Error ? error.message : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  completed = true; clearTimeout(watchdog); process.exitCode = 1;
});
