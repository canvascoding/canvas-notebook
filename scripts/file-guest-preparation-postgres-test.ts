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
import type { FileGuestInvitationPreparationSelection, PreparedFileGuestInvitation } from '../app/lib/file-guests/preparation';
import { FILE_GUEST_CONTENT_LIMIT } from '../app/lib/file-guests/content-contract';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
let completed = false;
process.once('beforeExit', () => {
  if (!completed) { console.error('Guest preparation backup fixture did not complete.', { stage }); process.exitCode = 1; }
});
const watchdog = setTimeout(() => {
  console.error('Guest preparation backup fixture exceeded its bounded deadline.', { stage }); process.exit(1);
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
  const schema = `guest_preparation_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^guest_preparation_[a-f0-9]{32}$/u);
  const dataRoot = await fs.mkdtemp(path.join(tmpdir(), 'canvas-guest-preparation-'));
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
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'principal-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true },
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
    const { withPreparedFileGuestInvitation: prepare } = await import('../app/lib/file-guests/preparation');
    const { withFileGuestMemberWriter } = await import('../app/lib/file-guests/writer');
    const { readNativeWorkspaceRecoveryRecords } = await import('../app/lib/collaboration/workspace-native-recovery');
    const { listWorkspaceOperationBackups } = await import('../app/lib/files/workspace-operation-backup');
    const { createPlainTextYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { inspectNativeDocument } = await import('../app/lib/collaboration/document-snapshot');
    const { nativeRichDocumentFixture, nativeTableWidthFixture } = await import('./helpers/rich-markdown-projection-fixtures');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { GET: info } = await import('../app/api/files/info/route');
    const { requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const root = path.join(dataRoot, 'organizations/principal-org/shared'); await fs.mkdir(root, { recursive: true });
    const request = (userId = 'owner') => new NextRequest('http://localhost/api/files/guests', {
      headers: { 'x-canvas-workspace-id': workspaceId, authorization: `Bearer ${tokens[userId]}` },
    });
    const cookieRequest = async () => {
      const actual = request('member'); actual.headers.delete('authorization');
      actual.headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', tokens.member, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      return actual;
    };
    const resolved = await requireRequestWorkspace(request(), { workspaceId, permissions: 'canRead' }); assert(!resolved.response);
    const workspace = resolved.workspace;
    const check = async (name: string, operation: () => Promise<void>) => { stage = name; await operation(); cases++; console.log(`Guest preparation passed: ${name}`); };
    const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === expected;
    const factory = (beforeOpen?: (ordinal: number) => Promise<void>) => {
      let opened = 0; const events: string[] = [];
      return { events, openConnection: async (): Promise<SqlConnection> => {
        await beforeOpen?.(++opened); const client = await ownClient(); let closed = false, active = false;
        const query = async (sql: string, values?: unknown[]) => {
          assert(!closed); const rows = (await client.query(sql, values)).rows;
          if (/^BEGIN$/u.test(sql.trim())) { active = true; transactions++; }
          if (/^(?:COMMIT|ROLLBACK)$/u.test(sql.trim())) { events.push(sql.trim()); if (active) transactions--; active = false; }
          return rows;
        };
        return { get: async (sql, values) => (await query(sql, values))[0], all: query, run: query,
          close: async () => { if (closed) return; closed = true; await endClient(client); if (active) transactions--; active = false; events.push('closed'); } };
      } };
    };
    const infoSelection = async (filePath: string): Promise<FileGuestInvitationPreparationSelection> => {
      const response = await info(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({ path: filePath })}`, { headers: request().headers }));
      assert.equal(response.status, 200);
      return { workspaceId, path: filePath, expectedTarget: (await response.json()).data.metadataTarget, operationId: crypto.randomUUID() };
    };
    const seed = async (filePath: string, representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text', sources: string[] = []) => {
      const documentId = `doc-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      let doc: InstanceType<typeof Y.Doc>;
      if (representation === 'plain_text') doc = createPlainTextYDoc(`Original\n${sources.map(source => `![Allowed](<${source}>)`).join('\n')}\n\`\`\`md\n![Hidden](not-granted.png)\n\`\`\`\n`);
      else {
        const table = nativeTableWidthFixture(representation);
        const content = inspectNativeDocument(table, representation).content; table.destroy(); assert.equal(content.kind, 'rich_text');
        if (content.kind !== 'rich_text') assert.fail();
        doc = nativeRichDocumentFixture({ ...content.document, content: [...(content.document.content ?? []),
          ...sources.map(source => ({ type: 'image', attrs: { src: source, alt: 'Allowed' } }))] }, representation);
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      }
      const update = Buffer.from(Y.encodeStateAsUpdate(doc)), vector = Buffer.from(Y.encodeStateVector(doc)); doc.destroy();
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','principal-org',$3,'active',100)`, [lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','principal-org',$4,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, workspaceId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,yjs_state,state_vector,
        document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,$2,'principal-org',$3,$4,1,1,$5,$6,7,100,0,NULL,NULL,NULL,'lf',0,0,'active')`, [documentId, workspaceId, filePath, representation, update, vector]);
      return { input: await infoSelection(filePath), identity: { documentId, lineageId, workspaceId, organizationId: 'principal-org',
        path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1 }, update, vector };
    };
    const currentRows = async () => Number((await admin.query('SELECT count(*) AS count FROM file_guest_invitations')).rows[0].count);
    const publish = (prepared: PreparedFileGuestInvitation, mutation: (database: SqlConnection) => Promise<void> = async () => undefined, actor = 'owner') =>
      withFileGuestMemberWriter(request(actor), { workspaceId, expectedTarget: prepared.target, permission: 'read' }, async access => {
              const { database, target } = access;
              await access.assertCurrent(); await prepared.assertCurrent(database); await mutation(database);
              await database.run(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,lineage_id,lifecycle_generation,email,
                permission,created_by_user_id,assets_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'read',$8,$9,100,100)`,
              [crypto.randomUUID(), workspaceId, prepared.path, target.documentId, target.lineageId, target.lifecycleGeneration,
                `${crypto.randomUUID()}@guest.test`, access.userId, JSON.stringify(prepared.assets)]);
              await access.assertCurrent(); await prepared.assertCurrent(database); return prepared.target;
      });
    const direct: SqlConnection = { get: async (sql, values) => (await admin.query(sql, values)).rows[0], all: async (sql, values) => (await admin.query(sql, values)).rows,
      run: async (sql, values) => (await admin.query(sql, values)).rows, close: () => assert.fail() };
    await fs.writeFile(path.join(root, 'asset.png'), 'Actual image fixture bytes'); await fs.writeFile(path.join(root, 'not-granted.png'), 'Not rendered');

    await check('native Plain/XML/Blocks invite from actual persisted content without physical Markdown or lossless export', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        const item = await seed(`native-${representation}.md`, representation, ['asset.png']);
        if (representation === 'tiptap_xml') await fs.writeFile(path.join(root, item.input.path), '# Deliberately obsolete projection\n');
        const before = await currentRows();
        const originalOpen = fs.open; let assetDescriptors = 0;
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          if (typeof args[0] === 'string' && args[0].endsWith('/asset.png')) {
            assert.equal(typeof args[1], 'number');
            assert.notEqual((args[1] as number) & constants.O_NOFOLLOW, 0);
            assert.notEqual((args[1] as number) & constants.O_NONBLOCK, 0); assetDescriptors++;
          }
          return originalOpen(...args);
        }) as typeof fs.open;
        try { await prepare(representation === 'tiptap_xml' ? await cookieRequest() : request(), item.input, async prepared => {
          assert(Object.isFrozen(prepared)); assert(Object.isFrozen(prepared.target)); assert(Object.isFrozen(prepared.assets));
          assert.deepEqual(prepared.assets.map(asset => asset.path), ['asset.png']); assert(prepared.backupId.startsWith('opb-'));
          await publish(prepared);
        }, factory()); } finally { fs.open = originalOpen; }
        assert(assetDescriptors >= 3, 'Preparation and actual member-writer rechecks use safe actual descriptors.');
        assert.equal(await currentRows(), before + 1);
        if (representation === 'tiptap_xml') assert.equal(await fs.readFile(path.join(root, item.input.path), 'utf8'), '# Deliberately obsolete projection\n');
        else await assert.rejects(fs.lstat(path.join(root, item.input.path)), { code: 'ENOENT' });
      }
    });
    await check('oversized persisted native bootstrap fails before any Guest invitation is published', async () => {
      const item = await seed('oversized-native.md');
      const doc = createPlainTextYDoc('x'.repeat(FILE_GUEST_CONTENT_LIMIT));
      try {
        await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3 WHERE document_id=$1',
          [item.identity.documentId, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
      } finally { doc.destroy(); }
      const before = await currentRows(); let published = false;
      await assert.rejects(prepare(request(), item.input, async prepared => { published = true; await publish(prepared); }, factory()),
        code('FILE_GUEST_PREPARATION_TOO_LARGE'));
      assert.equal(published, false); assert.equal(await currentRows(), before);
      await assert.rejects(fs.lstat(path.join(root, item.input.path)), { code: 'ENOENT' });
    });
    await check('actual physical Info bootstraps absent/pristine originals once before native baseline and member publication', async () => {
      for (const pristine of [false, true]) {
        const filePath = pristine ? 'pristine-original.md' : 'absent-original.md'; const bytes = Buffer.from('# Physical original\n');
        await fs.writeFile(path.join(root, filePath), bytes);
        if (pristine) await admin.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,organization_id,path,provider,state_version,yjs_state_lifecycle,status,created_at,updated_at)
          VALUES($1,$2,'organization','principal-org',$3,'yjs',0,'never_initialized','active',100,100)`, [`doc-${crypto.randomUUID()}`, workspaceId, filePath]);
        const input = await infoSelection(filePath); assert.equal(Reflect.get(input.expectedTarget as object, 'kind'), 'filesystem');
        await prepare(request(), input, async prepared => { assert.equal(prepared.target.kind, 'native_file'); await publish(prepared); }, factory());
        assert((await fs.readFile(path.join(root, filePath))).equals(bytes));
        assert.equal((await readNativeWorkspaceRecoveryRecords(direct, workspace, filePath)).length, 1);
        assert.equal(Number((await admin.query("SELECT count(*) AS count FROM collaboration_markdown_file_import_receipts WHERE private_result#>>'{target,path}'=$1", [filePath])).rows[0].count), 1);
      }
    });
    await check('stale physical version, readonly bootstrap and a native winner fail closed without adoption', async () => {
      const filePath = 'stale-source.md'; await fs.writeFile(path.join(root, filePath), '# Before\n'); const input = await infoSelection(filePath);
      await fs.writeFile(path.join(root, filePath), '# Replaced after Info\n'); let visited = false;
      await assert.rejects(prepare(request(), input, async () => { visited = true; }, factory()), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert.equal(visited, false);
      const readPath = 'read-only-original.md'; await fs.writeFile(path.join(root, readPath), '# Read only\n');
      await assert.rejects(prepare(request('member'), await infoSelection(readPath), async () => assert.fail(), factory()));
      assert.equal(Number((await admin.query('SELECT count(*) AS count FROM collaboration_yjs_states WHERE path=$1', [readPath])).rows[0].count), 0);
      const winnerPath = 'native-winner.md'; await fs.writeFile(path.join(root, winnerPath), '# Original disk\n'); const race = await infoSelection(winnerPath);
      let winner: Awaited<ReturnType<typeof seed>> | undefined;
      await assert.rejects(prepare(request(), race, async () => assert.fail(), factory(async ordinal => {
        if (ordinal === 2) winner = await seed(winnerPath);
      })), code('MARKDOWN_IMPORT_TARGET_CHANGED'));
      assert(winner); assert((await admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [winner.identity.documentId])).rows[0].yjs_state.equals(winner.update));
    });
    await check('actual FD identity rejects an asset replaced after preparation and rolls back the invitation', async () => {
      const item = await seed('asset-replace.md', 'plain_text', ['asset.png']); const before = await currentRows();
      try { await assert.rejects(prepare(request(), item.input, async prepared => publish(prepared, async () => {
        await fs.writeFile(path.join(root, 'asset.png'), 'Changed asset while waiting before SQL publication');
      }), factory()), code('FILE_GUEST_ASSET_CHANGED')); }
      finally { await fs.writeFile(path.join(root, 'asset.png'), 'Actual image fixture bytes'); }
      assert.equal(await currentRows(), before);
    });
    await check('relevant persisted image scope changes conflict; harmless peer text preserves prepared assets', async () => {
      for (const changedImage of [false, true]) {
        const item = await seed(`peer-${changedImage}.md`, 'plain_text', ['asset.png']); const before = await currentRows();
        const action = () => prepare(request(), item.input, async prepared => publish(prepared, async () => {
          const doc = createPlainTextYDoc(changedImage ? '![New](not-granted.png)\n' : 'Harmless peer text\n![Allowed](asset.png)\n');
          try { await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=8 WHERE document_id=$3',
            [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), item.identity.documentId]); }
          finally { doc.destroy(); }
        }), factory());
        if (changedImage) await assert.rejects(action(), code('FILE_GUEST_ASSET_CHANGED')); else await action();
        assert.equal(await currentRows(), before + (changedImage ? 0 : 1));
      }
    });
    await check('active real room is allowed, unsupported/sensitive/alias assets never gain a grant', async () => {
      await fs.mkdir(path.join(root, 'secrets')); await fs.writeFile(path.join(root, 'secrets', 'private.png'), 'Private');
      await fs.symlink(path.join(root, 'asset.png'), path.join(root, 'alias.png'));
      const item = await seed('active-asset.md', 'tiptap_blocks', ['asset.png', 'alias.png', 'missing.png', 'secrets/private.png', 'https://other.test/private.png',
        '/api/files/preview?path=not-granted.png&workspaceId=foreign-workspace']);
      const ownerClient = await ownClient(), owner = await createCollaborationRoomOwnerSession(ownerClient);
      const fence = await owner.acquire(item.identity);
      try { await prepare(request(), item.input, async prepared => { assert.deepEqual(prepared.assets.map(asset => asset.path), ['asset.png']); await publish(prepared); }, factory()); await owner.assertActive(fence); }
      finally { await owner.close(); clients.delete(ownerClient); }
    });
    await check('exact outer-space native target never selects its trimmed neighbor and retained preparation cannot be reused', async () => {
      const item = await seed(' Note (2).md ', 'plain_text', ['asset.png']); const neighbor = await seed('Note (2).md');
      let retained: PreparedFileGuestInvitation | undefined;
      await prepare(request(), item.input, async prepared => { retained = prepared; assert.equal(prepared.path, ' Note (2).md '); await publish(prepared); }, factory());
      assert(retained); await assert.rejects(retained.assertCurrent(), code('FILE_GUEST_PREPARATION_CHANGED'));
      assert((await admin.query('SELECT yjs_state FROM collaboration_yjs_states WHERE document_id=$1', [neighbor.identity.documentId])).rows[0].yjs_state.equals(neighbor.update));
      assert.equal((await admin.query('SELECT path FROM file_guest_invitations WHERE document_id=$1', [item.identity.documentId])).rows[0].path, ' Note (2).md ');
    });
    await check('root changes and current member revocation before member publication fail without an invitation', async () => {
      const item = await seed('scope-changed.md', 'plain_text', ['asset.png']); const before = await currentRows();
      try { await assert.rejects(prepare(request(), item.input, async prepared => {
        await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/elsewhere' WHERE id=$1", [workspaceId]);
        return publish(prepared);
      }, factory()), code('FILE_GUEST_PREPARATION_CHANGED')); }
      finally { await admin.query("UPDATE canvas_workspaces SET root_relative_path='organizations/principal-org/shared' WHERE id=$1", [workspaceId]); }
      try { await assert.rejects(prepare(request('member'), item.input, async prepared => {
        await admin.query("UPDATE organization_user_permissions SET status='disabled' WHERE user_id='member'"); return publish(prepared, undefined, 'member');
      }, factory())); }
      finally { await admin.query("UPDATE organization_user_permissions SET status='active' WHERE user_id='member'"); }
      assert.equal(await currentRows(), before);
    });
    await check('real kernel stays held through the awaited member transaction and final COMMIT', async () => {
      const item = await seed('held-through-commit.md'); const resource = new AsyncResource('guest-preparation-kernel-peer');
      let peer: Promise<void> | undefined, entered = false;
      try { await prepare(request(), item.input, async prepared => {
        peer = resource.runInAsyncScope(() => withWorkspaceMutationLock(workspaceId, async () => { entered = true; }));
        await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(entered, false);
        await publish(prepared); assert.equal(entered, false);
      }, factory()); } finally { await peer; resource.emitDestroy(); }
      assert.equal(entered, true);
      assert.equal((await listWorkspaceOperationBackups({ workspace })).backups.some(backup => backup.status === 'manifest_valid' && backup.originalPath === item.input.path), true);
    });
    assert.equal(fetches, 0); assert.equal(transactions, 0);
    console.log(`Guest Preparation PG18: ${cases} real Auth/Team/PG/FS matrix families passed; original bootstrap, native baseline, AST assets and member publication remain centrally bound.`);
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
  console.error('Guest preparation Backup fixture failed:', { stage, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null, message: error instanceof Error ? error.message : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1).filter(line => line.includes('/app/lib/') || line.includes('/scripts/')) : undefined });
  completed = true; clearTimeout(watchdog); process.exitCode = 1;
});
