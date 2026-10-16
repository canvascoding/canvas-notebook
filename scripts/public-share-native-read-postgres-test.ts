import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';

const sourcePath = path.resolve('scripts/public-share-native-read-postgres-test.ts');
const sourceHash = async () => crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex');

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', passed = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const originalSourceHash = await sourceHash();
  console.log('Public native read source pin:', originalSourceHash);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `public_native_read_${crypto.randomUUID().replaceAll('-', '')}`, nonce = crypto.randomUUID();
  assert.match(schema, /^public_native_read_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-public-share-native-read-'))), rootIdentity = await stat(dataRoot);
  assert.equal(rootIdentity.uid, process.getuid!()); assert.equal(rootIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>();
  let created = false, schemaOid = 0, schemaRemoved = false, dataRemoved = false, fetches = 0;
  let pool: { end: () => Promise<void> } | undefined, primaryFailure: unknown;
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100 -c application_name=public-native-read-fixture` });
    client.on('error', () => undefined); clients.add(client); await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); passed++; console.log('Public native read case passed:', JSON.stringify({ passed, name }));
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${nonce}'`);
    schemaOid = Number((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid);
    Object.assign(process.env, { DATABASE_URL: connectionString,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, CANVAS_DATABASE_PROVIDER: 'postgres',
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost',
      BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      CANVAS_ORGANIZATION_ID: 'native-read-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'NEXT_PHASE', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'native-read-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'native-read-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true }, seatLimit: 3, quotas: { users: 3 },
      entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('No network is permitted in the owned native read fixture.'); };
    const admin = await ownClient();
    const own = async () => {
      const row = (await admin.query(`SELECT current_schema() AS schema,current_setting('search_path') AS path,
        n.oid,obj_description(n.oid,'pg_namespace') AS nonce,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner
        FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0];
      assert(row); assert.equal(row.schema, schema); assert.equal(Number(row.oid), schemaOid); assert.equal(row.nonce, nonce); assert.equal(row.owner, true);
      assert.deepEqual(row.path.split(',').map((value: string) => value.trim()), [schema, 'pg_catalog']);
    };
    stage = 'original full migrations in owned schema';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      await own(); const result = await admin.query(sql, values); await own(); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const database = await import('../app/lib/db');
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 3);
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at) VALUES
      ('owner','Owner','owner@native-read.test',1,'admin',0,100,100),('member','Member','member@native-read.test',1,'user',0,100,100)`);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('native-read-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('native-read-org','owner','owner','active',1,1,100,100),('native-read-org','member','member','active',1,1,100,100)`);
    for (const userId of ['owner', 'member']) await admin.query(`INSERT INTO team_memberships
      (id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES($1,'native-read-org',$2,$3,$4,'active',100,100,100,100)`, [`seat-${userId}`, `${userId}@native-read.test`, userId, userId === 'owner' ? 'owner' : 'member']);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('native-read-org',100,100)");
    await admin.query(`INSERT INTO canvas_workspaces(id,organization_id,type,owner_user_id,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('native-read-space','native-read-org','organization',NULL,'Native read','organizations/native-read-org/shared','active',100,100)`);
    const creatorToken = crypto.randomBytes(32).toString('hex');
    await admin.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('native-read-session',$1,'member',$2,100,100)`, [creatorToken, Date.now() + 3600000]);
    const { auth } = await import('../app/lib/auth');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { readRichDocumentJson } = await import('../app/lib/collaboration/rich-document');
    const { equivalentRichDocument } = await import('../app/lib/markdown/core/equivalence');
    const { createRichMarkdownManager, richMarkdownCodecExtensions } = await import('../app/lib/markdown/rich-markdown-codec');
    const { getSchema } = await import('@tiptap/core');
    const sharing = await import('../app/lib/public-sharing/public-file-shares');
    const textReader = await import('../app/lib/public-sharing/public-share-text');
    const nativeExport = await import('../app/lib/public-sharing/native-public-export');
    const fileRoute = await import('../app/public/files/[token]/[...filename]/route');
    const assetRoute = await import('../app/public/markdown-assets/[token]/[...assetPath]/route');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'native-read-space'); assert(workspace);
    await mkdir(workspace.rootPath, { recursive: true });
    const creatorRequest = () => new NextRequest('http://localhost/api/security/public-shares', { method: 'POST', headers: {
      'x-canvas-workspace-id': workspace.workspaceId, authorization: `Bearer ${creatorToken}`,
    } });
    assert.equal((await auth.api.getSession({ headers: creatorRequest().headers }))?.session.id, 'native-read-session');
    const row = async (id: string) => (await admin.query('SELECT to_jsonb(s) AS row FROM public_file_shares s WHERE id=$1', [id])).rows[0]?.row as Row | undefined;
    await admin.query('CREATE SEQUENCE fixture_public_write_attempts');
    await admin.query(`CREATE FUNCTION fixture_count_public_writes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('fixture_public_write_attempts'); RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER fixture_public_write_attempt BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public_file_shares FOR EACH STATEMENT EXECUTE FUNCTION fixture_count_public_writes()`);
    const writeProof = async () => {
      const value = (await admin.query('SELECT last_value::text AS value,is_called FROM fixture_public_write_attempts')).rows[0];
      return value.is_called ? BigInt(value.value) : BigInt(0);
    };
    type Representation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
    type Native = { filePath: string; fullPath: string; documentId: string; lineageId: string; representation: Representation;
      canonical: string; expectedBytes: Buffer; document?: ReturnType<typeof readRichDocumentJson> };
    const nativeTargets: Native[] = [];
    const noFile = async (fullPath: string) => assert.rejects(stat(fullPath), { code: 'ENOENT' });
    const nativeAt = async (representation: Representation = 'plain_text', options: {
      filePath?: string; canonical?: string; newlineStyle?: 'lf' | 'crlf'; hasBom?: boolean; nonexportable?: boolean;
    } = {}): Promise<Native> => {
      const filePath = options.filePath ?? `native-${crypto.randomUUID()}.md`;
      const documentId = `native-${crypto.randomUUID()}`, lineageId = `lineage-${crypto.randomUUID()}`;
      const canonical = options.canonical ?? (representation === 'plain_text' ? 'Native plain Ä.\nAnother line.\n' : '# Native public\n\nA real paragraph.\n');
      const doc = representation === 'plain_text' ? new Y.Doc() : createRichMarkdownYDoc(canonical, representation);
      let update: Buffer, vector: Buffer, document: Native['document'];
      try {
        if (representation === 'plain_text') doc.getText('content').insert(0, canonical);
        if (options.nonexportable) {
          assert.equal(representation, 'tiptap_blocks');
          const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownCodecExtensions()));
          let cells = 0;
          for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
            (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]); cells++;
          }
          assert(cells > 0); const manager = createRichMarkdownManager(); document = readRichDocumentJson(doc);
          assert.equal(equivalentRichDocument(document, getSchema(richMarkdownCodecExtensions()).nodeFromJSON(manager.parse(manager.serialize(document))).toJSON()), false);
        } else if (representation !== 'plain_text') document = readRichDocumentJson(doc);
        update = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc));
      } finally { doc.destroy(); }
      await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'native-read-space','organization','native-read-org',$2,'active',100)`, [lineageId, filePath]);
      await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'native-read-space','organization','native-read-org',$3,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, filePath]);
      await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'native-read-space','native-read-org',$2,$3,5,1,$4,$5,7,100,7,100,'fixture','fixture',$6,$7,0,'active')`,
      [documentId, filePath, representation, update!, vector!, options.newlineStyle ?? 'lf', options.hasBom ? 1 : 0]);
      const serialized = (options.hasBom ? '\uFEFF' : '') + (options.newlineStyle === 'crlf' ? canonical.replace(/\n/gu, '\r\n') : canonical);
      const target = { filePath, fullPath: path.join(workspace.rootPath, filePath), documentId, lineageId, representation,
        canonical, expectedBytes: Buffer.from(serialized, 'utf8'), ...(document ? { document } : {}) };
      await noFile(target.fullPath); nativeTargets.push(target); return target;
    };
    const nativeProof = async (target: Native) => (await admin.query(`SELECT jsonb_build_object(
      'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
      'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
      'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`, [target.documentId, target.lineageId])).rows[0].snapshot as Row;
    const publish = async (filePath: string) => {
      const result = await sharing.createPublicFileShares({ paths: [filePath], request: creatorRequest(), workspaceId: workspace.workspaceId,
        createdByUserId: 'member', workspace });
      assert.equal(result.skipped.length, 0); assert.equal(result.shares.length, 1);
      const share = result.shares[0], stored = await row(share.id); assert(stored);
      assert.equal(typeof stored.token, 'string'); assert.equal(typeof share.shortCode, 'string'); assert.equal(share.shortCode!.length, 6);
      assert.equal(share.workspacePath, filePath); assert.equal(share.status, 'active');
      return { share, token: stored.token as string, shortCode: share.shortCode! };
    };
    type Published = Awaited<ReturnType<typeof publish>>;
    const resolveNative = async (publication: Published, target: Native, short = false, recordAccess = false) => {
      const resolved = short ? await sharing.resolvePublicShareShortCode(publication.shortCode, { recordAccess })
        : await sharing.resolvePublicShareToken(publication.token, { recordAccess });
      assert(resolved.ok); assert.equal(resolved.kind, 'native');
      if (resolved.kind !== 'native') throw new Error('Native fixture unexpectedly resolved as a physical file.');
      assert.equal(resolved.row.id, publication.share.id); assert.equal(resolved.snapshot.source, 'persisted_yjs');
      assert.equal(resolved.snapshot.documentId, target.documentId); assert.equal(resolved.snapshot.path, target.filePath);
      assert.equal(resolved.snapshot.lifecycleGeneration, 5); assert.equal(resolved.snapshot.representation, target.representation);
      assert.equal(resolved.row.documentId, target.documentId); assert.equal(resolved.row.lineageId, target.lineageId);
      assert.equal(resolved.row.lifecycleGeneration, 5); assert.equal('fullPath' in resolved, false);
      return resolved;
    };
    const fileRequest = async (publication: Published, method: 'GET' | 'HEAD' = 'GET', range?: string, requestedName = publication.share.fileName) => {
      const request = new NextRequest(`http://localhost/public/files/${publication.token}/${encodeURIComponent(requestedName)}?download=1`,
        { method, headers: range ? { range } : {} });
      assert.equal(request.headers.has('cookie'), false); assert.equal(request.headers.has('authorization'), false);
      const context = { params: Promise.resolve({ token: publication.token, filename: [requestedName] }) };
      const response = await fileRoute[method](request, context);
      assert.equal(response.headers.has('set-cookie'), false); return response;
    };
    const denied = async (publication: Published, tokenStatus: number, shortStatus = tokenStatus) => {
      const before = await row(publication.share.id), writes = await writeProof();
      const token = await sharing.resolvePublicShareToken(publication.token, { recordAccess: false });
      assert.equal(token.ok, false); if (token.ok) throw new Error('Rejected token resolved.'); assert.equal(token.status, tokenStatus);
      const short = await sharing.resolvePublicShareShortCode(publication.shortCode, { recordAccess: false });
      assert.equal(short.ok, false); if (short.ok) throw new Error('Rejected shortcode resolved.'); assert.equal(short.status, shortStatus);
      const response = await fileRequest(publication); assert.equal(response.status, tokenStatus);
      const body = await response.json(); assert.equal(body.success, false); assert.equal(typeof body.error, 'string');
      assert.deepEqual(await row(publication.share.id), before); assert.equal(await writeProof(), writes);
    };
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await check(`native ${representation} create, token, shortcode and real GET HEAD Range bytes without projection`, async () => {
      const target = await nativeAt(representation), before = await nativeProof(target), publication = await publish(target.filePath);
      const writes = await writeProof(), stored = await row(publication.share.id);
      const resolved = await resolveNative(publication, target); const short = await resolveNative(publication, target, true);
      assert.deepEqual(short.snapshot, resolved.snapshot); assert.deepEqual(resolved.exportProfile, { newlineStyle: 'lf', hasBom: false });
      assert.equal(await writeProof(), writes); assert.deepEqual(await row(publication.share.id), stored);
      assert.equal(await textReader.readPublicShareText(resolved), target.canonical);
      const get = await fileRequest(publication); assert.equal(get.status, 200);
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), target.expectedBytes); assert.equal(Number(get.headers.get('content-length')), target.expectedBytes.length);
      const afterGet = await row(publication.share.id); assert.equal(Number(afterGet!.access_count), 1);
      const beforeHead = await writeProof(), head = await fileRequest(publication, 'HEAD'); assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get('content-length')), target.expectedBytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(await writeProof(), beforeHead); assert.deepEqual(await row(publication.share.id), afterGet);
      const range = await fileRequest(publication, 'GET', 'bytes=2-11'); assert.equal(range.status, 206);
      assert.equal(range.headers.get('content-range'), `bytes 2-11/${target.expectedBytes.length}`);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), target.expectedBytes.subarray(2, 12));
      const invalid = await fileRequest(publication, 'HEAD', `bytes=${target.expectedBytes.length}-`); assert.equal(invalid.status, 416);
      assert.equal(invalid.headers.get('content-range'), `bytes */${target.expectedBytes.length}`);
      assert.deepEqual(await nativeProof(target), before); await noFile(target.fullPath);
    });
    await check('native CRLF and BOM profile determines emitted bytes and byte ranges', async () => {
      const target = await nativeAt('tiptap_xml', { newlineStyle: 'crlf', hasBom: true }), before = await nativeProof(target), publication = await publish(target.filePath);
      const resolved = await resolveNative(publication, target); assert.deepEqual(resolved.exportProfile, { newlineStyle: 'crlf', hasBom: true });
      const get = await fileRequest(publication); assert.equal(get.status, 200); assert.deepEqual(Buffer.from(await get.arrayBuffer()), target.expectedBytes);
      const range = await fileRequest(publication, 'GET', 'bytes=0-2'); assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from([0xef, 0xbb, 0xbf]));
      const head = await fileRequest(publication, 'HEAD'); assert.equal(Number(head.headers.get('content-length')), target.expectedBytes.length);
      assert.deepEqual(await nativeProof(target), before); await noFile(target.fullPath);
    });
    await check('native docx suffix exports real Markdown with text filename and MIME', async () => {
      const target = await nativeAt('tiptap_blocks', { filePath: `native-${crypto.randomUUID()}.docx` }), publication = await publish(target.filePath);
      await resolveNative(publication, target); const get = await fileRequest(publication); assert.equal(get.status, 200);
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), target.expectedBytes); assert.equal(get.headers.get('content-type'), 'text/markdown; charset=utf-8');
      const disposition = get.headers.get('content-disposition'); assert(disposition); assert(disposition.includes('.md')); assert.equal(disposition.includes('.docx'), false);
      await noFile(target.fullPath);
    });
    await check('native outer-space names keep exact identity apart from trimmed neighbor', async () => {
      const name = `native-${crypto.randomUUID()}.docx`, exact = ` ${name} `;
      const neighbor = await nativeAt('plain_text', { filePath: name, canonical: 'Distinct trimmed neighbor.\n' });
      const neighborShare = await publish(name);
      const target = await nativeAt('tiptap_xml', { filePath: exact }), publication = await publish(exact);
      const resolved = await resolveNative(publication, target); assert.notEqual(resolved.snapshot.documentId, neighbor.documentId);
      const response = await fileRequest(publication); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), target.expectedBytes);
      assert.notEqual(publication.share.id, neighborShare.share.id);
      const before = await row(publication.share.id), neighborBefore = await row(neighborShare.share.id), writes = await writeProof();
      const listed = await sharing.listPublicFileShares({ userId: 'member', workspace, paths: [exact], status: 'active' });
      assert.deepEqual(listed.map(share => [share.id, share.workspacePath]), [[publication.share.id, exact]]);
      const annotations = await sharing.getPublicShareAnnotations([exact], null, workspace);
      assert.deepEqual([...annotations].map(([filePath, annotation]) => [filePath, annotation.id]), [[exact, publication.share.id]]);
      const { serializeSignedCookie } = await import('better-call');
      const cookie = (await serializeSignedCookie('better-auth.session_token', creatorToken, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
      const search = new URLSearchParams({ path: exact, status: 'active', limit: '1000' });
      const request = new NextRequest(`http://localhost/api/security/public-shares?${search}`, {
        headers: { cookie, 'x-canvas-workspace-id': workspace.workspaceId },
      });
      assert.equal((await auth.api.getSession({ headers: request.headers }))?.session.id, 'native-read-session');
      const { GET } = await import('../app/api/security/public-shares/route');
      const management = await GET(request); assert.equal(management.status, 200); assert.equal(management.headers.has('set-cookie'), false);
      const body = await management.json(); assert.equal(body.success, true);
      assert.deepEqual(body.shares.map((share: { id: string; workspacePath: string }) => [share.id, share.workspacePath]), [[publication.share.id, exact]]);
      assert.deepEqual(await row(publication.share.id), before); assert.deepEqual(await row(neighborShare.share.id), neighborBefore);
      assert.equal(await writeProof(), writes);
      await noFile(target.fullPath); await noFile(neighbor.fullPath);
    });
    const assetStem = `native-assets-${crypto.randomUUID()}`, assetPath = `${assetStem}.png`, unreferencedPath = `${assetStem}-unreferenced.png`;
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
    let nonexportable: Native, nonexportableShare: Published;
    await check('nonexportable native table preview preserves actual AST without Markdown', async () => {
      await writeFile(path.join(workspace.rootPath, assetPath), image, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(workspace.rootPath, unreferencedPath), image, { flag: 'wx', mode: 0o600 });
      nonexportable = await nativeAt('tiptap_blocks', { nonexportable: true, canonical:
        `| Native width |\n| --- |\n| Preserved cell |\n\n![Approved image](${assetPath})\n` });
      const before = await nativeProof(nonexportable); nonexportableShare = await publish(nonexportable.filePath);
      const resolved = await resolveNative(nonexportableShare, nonexportable); assert.equal(resolved.snapshot.content.kind, 'rich_text');
      if (resolved.snapshot.content.kind !== 'rich_text') throw new Error('Native table lost its rich content.');
      assert.deepEqual(resolved.snapshot.content.document, nonexportable.document);
      assert(JSON.stringify(resolved.snapshot.content.document).includes('"colwidth":[120]'));
      assert.deepEqual(await nativeProof(nonexportable), before); await noFile(nonexportable.fullPath);
      // This proves server preview content, not a rendered browser UI acceptance.
    });
    await check('nonexportable native download is explicit 409 rather than lossy Markdown', async () => {
      const before = await nativeProof(nonexportable), resolved = await resolveNative(nonexportableShare, nonexportable);
      assert.throws(() => nativeExport.exportNativePublicSnapshot(resolved.snapshot, resolved.exportProfile), error =>
        error instanceof nativeExport.PublicShareNativeExportError && error.code === 'PUBLIC_SHARE_NATIVE_EXPORT_UNAVAILABLE');
      await assert.rejects(textReader.readPublicShareText(resolved), error => error instanceof textReader.PublicShareReadError && error.statusCode === 409);
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await fileRequest(nonexportableShare, method); assert.equal(response.status, 409);
        if (method === 'GET') { const body = await response.json(); assert.equal(body.success, false); assert.equal(typeof body.error, 'string');
          assert.equal(body.code, 'PUBLIC_SHARE_NATIVE_EXPORT_UNAVAILABLE'); }
      }
      assert.deepEqual(await nativeProof(nonexportable), before); await noFile(nonexportable.fullPath);
    });
    await check('oversize native export is explicit 413 while actual server snapshot remains readable', async () => {
      const target = await nativeAt('plain_text', { canonical: 'x'.repeat(5 * 1024 * 1024 + 1) }), publication = await publish(target.filePath);
      const resolved = await resolveNative(publication, target); assert.equal(resolved.snapshot.content.kind, 'plain_text');
      if (resolved.snapshot.content.kind !== 'plain_text') throw new Error('Oversize plain snapshot changed representation.');
      assert.equal(resolved.snapshot.content.text.length, target.canonical.length);
      const response = await fileRequest(publication); assert.equal(response.status, 413); const body = await response.json();
      assert.equal(body.success, false); assert.equal(body.code, 'PUBLIC_SHARE_NATIVE_EXPORT_TOO_LARGE'); await noFile(target.fullPath);
    });
    await check('real management revoke invalidates anonymous token shortcode and HTTP reads', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      const revoked = await sharing.revokePublicFileShare({ id: publication.share.id, request: creatorRequest(), workspaceId: workspace.workspaceId });
      assert.equal(revoked?.status, 'revoked'); await denied(publication, 410, 404);
    });
    await check('expired native publication denies all public entrypoints without reader writes', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query('UPDATE public_file_shares SET expires_at=100 WHERE id=$1', [publication.share.id]); await denied(publication, 410, 404);
    });
    await check('original generation mismatch cannot read the same native document', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query('UPDATE collaboration_yjs_states SET lifecycle_generation=6 WHERE document_id=$1', [target.documentId]); await denied(publication, 409);
    });
    await check('quarantined native state cannot be publicly read or exported', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query('UPDATE collaboration_yjs_states SET degraded=1 WHERE document_id=$1', [target.documentId]); await denied(publication, 409);
    });
    await check('archived original registry invalidates native public authority', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [target.documentId]); await denied(publication, 409);
    });
    await check('archived original lineage invalidates native public authority', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=200 WHERE id=$1", [target.lineageId]); await denied(publication, 409);
    });
    await check('same path replacement does not retarget an original native publication', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath);
      await admin.query("UPDATE collaboration_documents SET status='archived' WHERE id=$1", [target.documentId]);
      await admin.query("UPDATE file_collaboration_lineages SET status='archived',archived_at=200 WHERE id=$1", [target.lineageId]);
      await admin.query("UPDATE collaboration_yjs_states SET status='archived' WHERE document_id=$1", [target.documentId]);
      const replacement = await nativeAt('plain_text', { filePath: target.filePath, canonical: 'Replacement must remain private.\n' });
      assert.notEqual(replacement.documentId, target.documentId); await denied(publication, 409);
      assert.equal((await row(publication.share.id))!.document_id, target.documentId);
    });
    await check('historical all-null physical share never promotes to a later native document by path', async () => {
      const filePath = `physical-${crypto.randomUUID()}.txt`, fullPath = path.join(workspace.rootPath, filePath);
      await writeFile(fullPath, 'Original physical public text.\n', { flag: 'wx', mode: 0o600 }); const publication = await publish(filePath);
      const stored = await row(publication.share.id); assert(stored);
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal(stored[key], null);
      await unlink(fullPath); await nativeAt('plain_text', { filePath, canonical: 'Later native private text.\n' });
      // Even a now-missing historical physical target must remain read-only:
      // the later native document grants no path promotion or reconciliation DML.
      await denied(publication, 404);
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal((await row(publication.share.id))![key], null);
    });
    await check('recordAccess false and actual HEAD leave counter row and DML witness unchanged', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), before = await row(publication.share.id), writes = await writeProof();
      await resolveNative(publication, target); await resolveNative(publication, target, true);
      const response = await fileRequest(publication, 'HEAD'); assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.deepEqual(await row(publication.share.id), before); assert.equal(await writeProof(), writes);
    });
    await check('recordAccess true updates the actual native counter once without changing policy or pins', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), before = await row(publication.share.id); assert(before);
      const writes = await writeProof(), resolved = await resolveNative(publication, target, false, true), after = await row(publication.share.id); assert(after);
      assert.equal(resolved.row.accessCount, 1); assert.equal(Number(after.access_count), 1); assert.equal(await writeProof(), writes + BigInt(1));
      assert(Number(after.last_accessed_at) > 0);
      assert.deepEqual({ ...after, access_count: before.access_count, last_accessed_at: before.last_accessed_at }, before);
    });
    await check('a captured native snapshot becomes unavailable after actual state version changes', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), resolved = await resolveNative(publication, target);
      const doc = new Y.Doc(); let bytes: Buffer, vector: Buffer;
      try { doc.getText('content').insert(0, 'A newer actual persisted version.\n'); bytes = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc)); }
      finally { doc.destroy(); }
      await admin.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,document_sequence=8,persisted_at=200 WHERE document_id=$3', [bytes!, vector!, target.documentId]);
      await admin.query('UPDATE collaboration_documents SET state_version=8 WHERE id=$1', [target.documentId]);
      await assert.rejects(textReader.readPublicShareText(resolved), error => error instanceof textReader.PublicShareReadError && error.statusCode === 409);
      const current = await resolveNative(publication, target); assert.equal(current.snapshot.version.documentSequence, 8);
      assert.equal(current.snapshot.content.kind, 'plain_text'); if (current.snapshot.content.kind === 'plain_text') assert.equal(current.snapshot.content.text, 'A newer actual persisted version.\n');
    });
    const assetRequest = async (asset: string, method: 'GET' | 'HEAD' = 'GET') => {
      const request = new NextRequest(`http://localhost/public/markdown-assets/${nonexportableShare.token}/${encodeURIComponent(asset)}`, { method });
      assert.equal(request.headers.has('cookie'), false); assert.equal(request.headers.has('authorization'), false);
      const response = await assetRoute[method](request, { params: Promise.resolve({ token: nonexportableShare.token, assetPath: [asset] }) });
      assert.equal(response.headers.has('set-cookie'), false); return response;
    };
    await check('native nonexportable AST image reference authorizes only the actual public image route', async () => {
      const before = await nativeProof(nonexportable), stored = await row(nonexportableShare.share.id), writes = await writeProof();
      const response = await assetRequest(assetPath); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
      assert.equal(response.headers.get('content-type'), 'image/png'); const head = await assetRequest(assetPath, 'HEAD'); assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get('content-length')), image.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.deepEqual(await nativeProof(nonexportable), before); assert.deepEqual(await row(nonexportableShare.share.id), stored); assert.equal(await writeProof(), writes);
    });
    await check('an existing but unreferenced image remains unavailable through the native asset route', async () => {
      const before = await row(nonexportableShare.share.id), writes = await writeProof();
      const response = await assetRequest(unreferencedPath); assert.equal(response.status, 404); assert.equal((await response.json()).success, false);
      assert.deepEqual(await row(nonexportableShare.share.id), before); assert.equal(await writeProof(), writes);
    });
    await check('actual anonymous counter COMMIT lost ACK returns 503 without retry or duplicate counting', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), before = await row(publication.share.id); assert(before);
      const proof = await nativeProof(target), writes = await writeProof(), originalQuery = Client.prototype.query;
      const releases = new Map<Client, (error?: Error) => void>();
      const lostAck = Object.assign(new Error('Owned fixture lost only the reply of a successful actual native counter COMMIT.'), { code: 'ECONNRESET' });
      let pid = 0, updates = 0, commits = 0, rollbacks = 0, disposals = 0, committed = false, disposed = false, discarded = false;
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const sql = typeof args[0] === 'string' ? args[0].replace(/\s+/gu, ' ').trim() : '';
        const values: unknown[] = Array.isArray(args[1]) ? args[1] : [];
        const parameters: unknown = Reflect.get(this, 'connectionParameters');
        const ownRuntime = this !== admin && parameters && typeof parameters === 'object'
          && String(Reflect.get(parameters, 'options') ?? '').includes(`search_path=${schema},pg_catalog`)
          && typeof Reflect.get(this, 'release') === 'function';
        if (ownRuntime && sql.startsWith(`UPDATE "${schema}".public_file_shares SET access_count=access_count+1,`)
          && values[1] === publication.share.id) {
          updates++; pid = Number(Reflect.get(this, 'processID'));
          if (!releases.has(this)) {
            const release = Reflect.get(this, 'release') as (error?: Error) => void; releases.set(this, release);
            Reflect.set(this, 'release', (error?: Error) => {
              disposals++; discarded = error instanceof Error;
              const result = Reflect.apply(release, this, [error]); disposed = true; return result;
            });
          }
        }
        if (releases.has(this)) {
          if (sql === 'ROLLBACK') rollbacks++;
          if (sql === 'COMMIT') {
            commits++; return Promise.resolve(Reflect.apply(originalQuery, this, args)).then(() => {
              committed = true; throw lostAck;
            });
          }
        }
        return Reflect.apply(originalQuery, this, args);
      } as typeof Client.prototype.query;
      try {
        const resolved = await sharing.resolvePublicShareToken(publication.token, { recordAccess: true });
        assert.equal(resolved.ok, false); if (resolved.ok) throw new Error('An unconfirmed public read escaped as success.');
        assert.equal(resolved.status, 503);
      } finally {
        Client.prototype.query = originalQuery;
        for (const [client, release] of releases) Reflect.set(client, 'release', release);
      }
      assert(committed); assert(disposed); assert(discarded); assert(pid > 0);
      assert.equal(updates, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(disposals, 1); assert.equal(releases.size, 1);
      const deadline = Date.now() + 5000;
      while (!(await admin.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [pid])).rows[0].absent) {
        assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
      }
      const persisted = await row(publication.share.id); assert(persisted); assert.equal(Number(persisted.access_count), 1);
      assert.equal(await writeProof(), writes + BigInt(1)); assert(Number(persisted.last_accessed_at) > 0);
      assert.deepEqual({ ...persisted, access_count: before.access_count, last_accessed_at: before.last_accessed_at }, before);
      const afterFaultWrites = await writeProof(), current = await resolveNative(publication, target);
      assert.equal(current.row.accessCount, 1); assert.deepEqual(await row(publication.share.id), persisted);
      assert.equal(await writeProof(), afterFaultWrites); assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
    });
    await check('actual afterWrite preserves native share authority and still refreshes all-null physical metadata', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), before = await row(publication.share.id); assert(before);
      const proof = await nativeProof(target), writes = await writeProof();
      await writeFile(target.fullPath, target.expectedBytes, { flag: 'wx', mode: 0o600 });
      const projection = await stat(target.fullPath);
      try {
        await sharing.syncPublicSharesAfterWrite([target.filePath], workspace);
        assert.deepEqual(await row(publication.share.id), before);
        assert.equal(await writeProof(), writes);
        const resolved = await resolveNative(publication, target);
        assert.equal(await textReader.readPublicShareText(resolved), target.canonical);
        assert.deepEqual(await nativeProof(target), proof);
        assert.deepEqual(await row(publication.share.id), before); assert.equal(await writeProof(), writes);
      } finally {
        const current = await stat(target.fullPath);
        assert(current.isFile()); assert.equal(current.nlink, 1); assert.equal(current.uid, rootIdentity.uid);
        assert.equal(current.dev, projection.dev); assert.equal(current.ino, projection.ino);
        assert.equal(await realpath(target.fullPath), target.fullPath);
        await unlink(target.fullPath);
      }
      await noFile(target.fullPath);
      const filePath = `physical-refresh-${crypto.randomUUID()}.txt`, fullPath = path.join(workspace.rootPath, filePath);
      await writeFile(fullPath, 'Original physical share.\n', { flag: 'wx', mode: 0o600 });
      const physical = await publish(filePath), physicalBefore = await row(physical.share.id); assert(physicalBefore);
      for (const key of ['document_id', 'lineage_id', 'lifecycle_generation']) assert.equal(physicalBefore[key], null);
      const replacementText = 'The real physical share now has a different content length and revision.\n';
      await writeFile(fullPath, replacementText); const current = await stat(fullPath), physicalWrites = await writeProof();
      await sharing.syncPublicSharesAfterWrite([filePath], workspace);
      const physicalAfter = await row(physical.share.id); assert(physicalAfter);
      const identity = `${current.dev}:${current.ino}:${current.birthtimeMs}`;
      const revision = `${Math.trunc(current.mtimeMs)}:${current.size}:${identity}`;
      assert.notEqual(revision, physicalBefore.last_known_revision);
      assert(Number(physicalAfter.updated_at) >= Number(physicalBefore.updated_at));
      assert.deepEqual({ ...physicalAfter, updated_at: physicalBefore.updated_at }, { ...physicalBefore,
        file_identity: identity, last_known_revision: revision, size_bytes: current.size,
        mime_type: 'text/plain; charset=utf-8', file_name: filePath });
      assert.equal(await writeProof(), physicalWrites + BigInt(1));
      const resolved = await sharing.resolvePublicShareToken(physical.token, { recordAccess: false }); assert(resolved.ok);
      assert.equal(resolved.kind, 'physical'); assert.equal(await textReader.readPublicShareText(resolved), replacementText);
      assert.deepEqual(await row(physical.share.id), physicalAfter); assert.equal(await writeProof(), physicalWrites + BigInt(1));
    });
    await check('native readonly and counted public reads coexist with actual workspace SHARE table lock', async () => {
      const target = await nativeAt(), publication = await publish(target.filePath), before = await row(publication.share.id); assert(before);
      const proof = await nativeProof(target), writes = await writeProof(), blocker = await ownClient();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`LOCK TABLE "${schema}".canvas_workspaces IN SHARE MODE`);
        const locks = (await blocker.query(`SELECT current_schema() AS schema,l.mode,l.granted FROM pg_locks l
          WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND l.relation=$1::regclass AND l.mode='ShareLock'`,
        [`"${schema}".canvas_workspaces`])).rows;
        assert.equal(locks.length, 1); assert.equal(locks[0].schema, schema);
        assert.equal(locks[0].mode, 'ShareLock'); assert.equal(locks[0].granted, true);
        // The awaited real LOCK and pg_locks witness are the readiness gate.
        // No timing assumption, fake lock, query result or authority is used.
        await resolveNative(publication, target);
        assert.deepEqual(await row(publication.share.id), before); assert.equal(await writeProof(), writes);
        const counted = await resolveNative(publication, target, false, true), after = await row(publication.share.id); assert(after);
        assert.equal(counted.row.accessCount, 1); assert.equal(Number(after.access_count), 1);
        assert(Number(after.last_accessed_at) > 0); assert.equal(await writeProof(), writes + BigInt(1));
        assert.deepEqual({ ...after, access_count: before.access_count, last_accessed_at: before.last_accessed_at }, before);
        const readonly = await resolveNative(publication, target); assert.equal(readonly.row.accessCount, 1);
        assert.deepEqual(await row(publication.share.id), after); assert.equal(await writeProof(), writes + BigInt(1));
        assert.deepEqual(await nativeProof(target), proof); await noFile(target.fullPath);
      } finally {
        try { await blocker.query('ROLLBACK'); } finally { await endClient(blocker); }
      }
    });
    await check('absolute public read selectors preserve exact native names and never widen an outside filter', async () => {
      const name = `absolute-native-${crypto.randomUUID()}.md`, exact = ` ${name} `;
      const target = await nativeAt('plain_text', { filePath: exact }), publication = await publish(exact);
      const neighbor = await nativeAt('tiptap_xml', { filePath: name }), neighborShare = await publish(name);
      const outside = path.join(dataRoot, `outside-selector-${crypto.randomUUID()}.md`);
      assert.equal(outside.startsWith(`${workspace.rootPath}${path.sep}`), false);
      await writeFile(outside, 'Owned file outside the selected workspace.\n', { flag: 'wx', mode: 0o600 });
      assert((await stat(outside)).isFile());
      const before = await row(publication.share.id), neighborBefore = await row(neighborShare.share.id), writes = await writeProof();
      const listed = await sharing.listPublicFileShares({ userId: 'member', workspace, paths: [target.fullPath], status: 'active' });
      assert.deepEqual(listed.map(share => [share.id, share.workspacePath]), [[publication.share.id, exact]]);
      const annotations = await sharing.getPublicShareAnnotations([target.fullPath], null, workspace);
      assert.deepEqual([...annotations].map(([filePath, annotation]) => [filePath, annotation.id]), [[exact, publication.share.id]]);
      const { serializeSignedCookie } = await import('better-call');
      const cookie = (await serializeSignedCookie('better-auth.session_token', creatorToken, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
      const { GET } = await import('../app/api/security/public-shares/route');
      const managementSelection = async (candidate: string) => {
        const search = new URLSearchParams({ path: candidate, status: 'active', limit: '1000' });
        const request = new NextRequest(`http://localhost/api/security/public-shares?${search}`, {
          headers: { cookie, 'x-canvas-workspace-id': workspace.workspaceId },
        });
        assert.equal((await auth.api.getSession({ headers: request.headers }))?.session.id, 'native-read-session');
        const response = await GET(request); assert.equal(response.status, 200); assert.equal(response.headers.has('set-cookie'), false);
        const body = await response.json(); assert.equal(body.success, true);
        return body.shares.map((share: { id: string; workspacePath: string }) => [share.id, share.workspacePath]);
      };
      assert.deepEqual(await managementSelection(target.fullPath), [[publication.share.id, exact]]);
      assert.deepEqual(await sharing.listPublicFileShares({ userId: 'member', workspace, paths: [outside], status: 'active' }), []);
      assert.deepEqual(await managementSelection(outside), []);
      assert.equal((await sharing.getPublicShareAnnotations([outside], null, workspace)).size, 0);
      for (const [candidate, id, filePath] of [[exact, publication.share.id, exact], [name, neighborShare.share.id, name],
        [`./${name}`, neighborShare.share.id, name]]) {
        const selected = await sharing.listPublicFileShares({ userId: 'member', workspace, paths: [candidate], status: 'active' });
        assert.deepEqual(selected.map(share => [share.id, share.workspacePath]), [[id, filePath]]);
      }
      assert.deepEqual(await row(publication.share.id), before); assert.deepEqual(await row(neighborShare.share.id), neighborBefore);
      assert.equal(await writeProof(), writes); await noFile(target.fullPath); await noFile(neighbor.fullPath);
    });
    await check('native anonymous public authority survives creator session removal without reauthentication', async () => {
      const target = await nativeAt('tiptap_blocks'), publication = await publish(target.filePath);
      await admin.query('DELETE FROM "session" WHERE id=$1', ['native-read-session']);
      assert.equal(Number((await admin.query('SELECT count(*) AS count FROM "session"')).rows[0].count), 0);
      assert.equal(await auth.api.getSession({ headers: creatorRequest().headers }), null);
      const resolved = await resolveNative(publication, target); await resolveNative(publication, target, true);
      assert.equal(resolved.workspace.permissions.canRead, true); assert.equal(resolved.workspace.permissions.canWrite, false);
      assert.equal(resolved.workspace.permissions.canDelete, false); assert.equal(resolved.workspace.permissions.canCreatePublicLinks, false);
      const response = await fileRequest(publication); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), target.expectedBytes);
    });
    assert.equal(passed, 27);
    for (const target of nativeTargets) await noFile(target.fullPath);
    assert.equal(fetches, 0); await own(); assert.equal(await sourceHash(), originalSourceHash);
    console.log('Public native read SQL assertions complete:', JSON.stringify({ passed, fetches, sourceSha256: originalSourceHash }));
  } catch (error) { primaryFailure = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupErrors.push(error); } };
    if (pool) await cleanup(() => pool!.end());
    for (const client of clients) await cleanup(() => endClient(client));
    if (created && clients.size === 0 && cleanupErrors.length === 0) await cleanup(async () => {
      const record = (await control.query(`SELECT oid,obj_description(oid,'pg_namespace') AS nonce,
        nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
      assert(record); assert.equal(Number(record.oid), schemaOid); assert.equal(record.nonce, nonce); assert.equal(record.owner, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed === true; assert(schemaRemoved);
    });
    await cleanup(() => control.end());
    await cleanup(async () => {
      const current = await stat(dataRoot); assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.uid, rootIdentity.uid);
      await rm(dataRoot, { recursive: true }); await assert.rejects(stat(dataRoot), error => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'); dataRemoved = true;
    });
    await cleanup(async () => { assert.equal(await sourceHash(), originalSourceHash); });
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    console.log('Public share native read owned cleanup:', JSON.stringify({ schemaRemoved, dataRemoved, openClients: clients.size, passed }));
    if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Owned public native read fixture cleanup failed.');
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  assert(schemaRemoved); assert(dataRemoved); complete = true;
  console.log('Public share native read PostgreSQL18 finished:', JSON.stringify({ passed, schemaRemoved, dataRemoved }));
}
main().catch(error => {
  const assertion = error instanceof assert.AssertionError ? error : null;
  const safeScalar = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const operators = ['strictEqual', 'deepStrictEqual', 'equal', 'notEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'notDeepStrictEqual',
    'ok', '==', '===', '!=', '!==', 'rejects', 'throws', 'doesNotReject', 'doesNotThrow', 'match', 'doesNotMatch', 'fail'];
  const frame = error instanceof Error ? error.stack?.split('\n').find(line => /^\s+at\s/u.test(line) && line.includes(`${sourcePath}:`)) : undefined;
  const location = frame ? /:(\d+):(\d+)\)?$/u.exec(frame) : null;
  console.error('Owned public native read fixture failed:', { stage, passed, name: error instanceof Error ? error.name : 'unknown',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? null : null,
    ...(assertion ? { assertionOperator: operators.includes(assertion.operator) ? assertion.operator : 'other',
      actual: safeScalar(assertion.actual), expected: safeScalar(assertion.expected) } : {}),
    sourceFrame: location ? `${sourcePath}:${Number(location[1])}:${Number(location[2])}` : null }); process.exitCode = 1;
});
