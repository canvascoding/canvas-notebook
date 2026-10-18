import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { test, type APIResponse, type BrowserContext, type TestInfo } from '@playwright/test';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { DirectMcpFileReceipt } from '../app/lib/mcp/server/file-ingest';
import { authorizeIngestE2EMcp, type IngestE2EToolResult } from '../scripts/mcp-file-ingest-e2e-helpers';
import { assertDatabaseOwnership, assertOwnedRoot, privateBytes, requireOwnedYjsQaTarget,
  type DatabaseIdentity, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';

// The existing supervisor alone owns the actual compiled production host,
// issuer, DB and browser process. Every write/authorization crosses real HTTP.
const spec = 'tests/direct-mcp-native-create-import.spec.ts';
const origin = process.env.BASE_URL ?? '';
const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
const tools = ['auth_probe', 'create_knowledge_source', 'import_knowledge_file', 'read_knowledge_source'];
const scopes = ['openid', 'offline_access', 'workspace:list', 'knowledge:read', 'knowledge:write'];
type Row = Record<string, unknown>;
type Mcp = Awaited<ReturnType<typeof authorizeIngestE2EMcp>>;
type Identity = Readonly<{ userId: string; sessionId: string }>;
type Workspace = Readonly<{ id: string; name: string; rootRelativePath: string }>;
type Original = Readonly<{ receipt: DirectMcpFileReceipt; source: Buffer; native: DocumentReadPageV1 }>;
type Probe = Readonly<{ backendPid: number; readOnly: true; xidUnassigned: true; closed: true }>;
const contexts: BrowserContext[] = [], signedOut = new Set<BrowserContext>();
let owned: OwnedYjsReceipt, contextA: BrowserContext | undefined, contextB: BrowserContext | undefined;
let mcpA: Mcp | undefined, mcpB: Mcp | undefined, identityA: Identity | undefined, identityB: Identity | undefined;
let workspace: Workspace | undefined, protocol = '', issuer = '', importArgs: Row | undefined;
let initialSettings: { enabled: boolean; tools: string[] } | undefined;
let originals: Original[] = [], before: Row[] | undefined;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'A complete JSON object is required.'); return value as Row;
}
function code(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(value) ? value : 'UNCLASSIFIED';
}
async function json(response: APIResponse, label: string): Promise<Row> {
  const bytes = await response.body(); assert(bytes.length <= 256 * 1024, `${label}: bounded response required.`);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new Error(`${label}: valid complete UTF-8 JSON required.`); }
}
async function ok(response: APIResponse, label: string): Promise<Row> {
  const value = await json(response, label); assert(response.ok(), `${label}: HTTP ${response.status()}.`); return value;
}
function success(result: IngestE2EToolResult): Row {
  if (result.isError === true) throw new Error(`Actual MCP tool rejected: ${code(result.structuredContent?.code)}.`);
  return object(result.structuredContent);
}
function fileReceipt(result: IngestE2EToolResult): DirectMcpFileReceipt {
  const value = success(result); assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse(result.content[0].text ?? ''), value);
  for (const name of ['operation_id', 'document_id', 'lineage_id', 'revision_id', 'workspace_id', 'path', 'sha256']) {
    assert(typeof value[name] === 'string' && String(value[name]).length > 0, `Receipt field ${name} is required.`);
  }
  assert(['created', 'already_created'].includes(String(value.status))); assert.match(String(value.sha256), /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(value.size) && Number(value.size) >= 0); return value as DirectMcpFileReceipt;
}
async function login(context: BrowserContext): Promise<Identity> {
  const email = process.env.TEST_LOGIN_EMAIL, password = process.env.TEST_LOGIN_PASSWORD; assert(email && password);
  await ok(await context.request.post('/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email, password }, maxRedirects: 0 }), 'Fresh ordinary login');
  const session = await ok(await context.request.get('/api/auth/get-session', { maxRedirects: 0 }), 'Fresh real session');
  const user = object(session.user), current = object(session.session);
  assert.equal(user.email, email); assert(typeof user.id === 'string' && user.id); assert(typeof current.id === 'string' && current.id);
  assert((await context.storageState()).cookies.length > 0); return { userId: user.id, sessionId: current.id };
}
async function reviewOff(context: BrowserContext): Promise<void> {
  const response = await ok(await context.request.get('/api/document-review/availability'), 'Review availability');
  assert.equal(object(response.data).documentReviewEnabled, false);
}
function tokenIdentity(client: Mcp, identity: Identity): void {
  const observed = client.observeTokenIdentity();
  // Parsing these actual issued bytes is observation only. The same private
  // token closure must also succeed through the real HTTP principal below.
  assert.equal(observed.clientId, client.registration.clientId); assert.equal(observed.userId, identity.userId);
  assert.equal(observed.sessionId, identity.sessionId); assert.equal(observed.issuer, issuer);
  assert(observed.audiences.includes(`${origin}/mcp`));
  assert(observed.audiences.every(value => value === `${origin}/mcp` || value === `${issuer}/oauth2/userinfo`));
}
async function nativeRead(client: Mcp, receipt: DirectMcpFileReceipt, expectedVersion?: string): Promise<DocumentReadPageV1> {
  const page = success(await client.call('read_knowledge_source', { workspace_id: receipt.workspace_id,
    document_id: receipt.document_id, format: 'native', max_bytes: 262144,
    ...(expectedVersion ? { expected_version: expectedVersion } : {}) })) as unknown as DocumentReadPageV1;
  assert.deepEqual(Object.keys(page).sort(), ['apiVersion', 'document', 'currency', 'projection', 'format', 'mediaType',
    'encoding', 'fragment', 'byteOffset', 'byteLength', 'totalBytes', 'nextCursor', 'complete'].sort());
  assert.equal(page.apiVersion, 1); assert.equal(page.format, 'native'); assert.equal(page.encoding, 'utf-8');
  assert.equal(page.mediaType, 'application/vnd.canvas.native-document+json'); assert.equal(page.document.kind, 'native_document');
  assert.equal(page.document.documentId, receipt.document_id); assert.equal(page.document.lineageId, receipt.lineage_id);
  assert.equal(page.document.workspaceId, receipt.workspace_id); assert.equal(page.document.path, receipt.path);
  assert.equal(page.document.lifecycleGeneration, 1); assert.equal(page.document.schemaVersion, 1);
  assert.match(page.document.version, /^canvas-document-v1:[a-f0-9]{64}$/u);
  assert.match(page.document.metadataVersion, /^canvas-document-metadata-v1:[a-f0-9]{64}$/u);
  assert.equal(page.currency.source, 'persisted_yjs'); assert.equal(page.currency.observedDurable, true);
  assert.equal(page.currency.observedVersion, page.document.version); assert.equal(page.currency.durableVersion, page.document.version);
  assert.equal(page.currency.durableSequence, 0); assert.equal(page.byteOffset, 0);
  assert.equal(page.byteLength, Buffer.byteLength(page.fragment)); assert.equal(page.totalBytes, page.byteLength);
  assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
  const body = object(JSON.parse(page.fragment)); assert.equal(body.bodyVersion, 1); assert(object(body.content));
  if (expectedVersion) assert.equal(page.document.version, expectedVersion); return page;
}
async function ownedFile(file: string, maxBytes: number) {
  await assertOwnedRoot(owned); assert(file.startsWith(`${owned.dataRoot}${path.sep}`)); assert.equal(await fs.realpath(file), file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = await handle.stat(); assert(a.isFile() && a.nlink === 1 && a.uid === process.getuid?.() && a.size <= maxBytes);
    const bytes = Buffer.alloc(a.size); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); assert(read.bytesRead > 0); offset += read.bytesRead; }
    assert.equal((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead, 0);
    for (const b of [await handle.stat(), await fs.lstat(file)]) for (const key of ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(b[key], a[key]);
    return { bytes, identity: { dev: String(a.dev), ino: String(a.ino), uid: a.uid, mode: a.mode, size: a.size, mtimeMs: a.mtimeMs, ctimeMs: a.ctimeMs } };
  } finally { await handle.close(); }
}
async function snapshotOriginals(): Promise<{ rows: Row[]; probe: Probe }> {
  await requireOwnedYjsQaTarget(); assert(workspace && identityA && mcpA && originals.length === 2);
  const database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c application_name=native-mcp-http-original-read' });
  const rows: Row[] = [];
  let ended = false, asyncError: Error | undefined, primary: unknown, failed = false, backendPid = 0;
  database.once('end', () => { ended = true; }); database.on('error', error => { asyncError ??= error; });
  try {
    await database.connect(); await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = (await database.query<Row>(`SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
      current_user AS role,shobj_description(d.oid,'pg_database') AS marker,pg_backend_pid() AS pid,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
      pg_current_xact_id_if_assigned() IS NULL AS unassigned FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert(actual); assertDatabaseOwnership(owned, actual as unknown as DatabaseIdentity);
    assert.equal(actual.read_only, 'on'); assert.equal(actual.isolation, 'repeatable read'); assert.equal(actual.unassigned, true);
    assert(typeof actual.pid === 'number'); backendPid = actual.pid;
    const anchor = object(JSON.parse((await privateBytes(path.join(owned.dataRoot, 'canvas-markdown-create-births-anchor.json'))).toString()));
    const store = anchor.version === 1 ? 'canvas-markdown-create-births' : String(anchor.storeName);
    assert.match(store, /^canvas-markdown-create-births(?:-[a-f0-9]{32})?$/u);
    for (const original of originals) {
      const r = original.receipt, values = [r.workspace_id, r.operation_id];
      const imports = (await database.query<Row>(`SELECT to_jsonb(r)-'after_state_snapshot' AS value,
        encode(sha256(r.after_state_snapshot),'hex') AS snapshot_sha256,r.xmin::text AS xmin
        FROM collaboration_markdown_file_import_receipts r WHERE workspace_id=$1 AND operation_id=$2`, values)).rows;
      const births = (await database.query<Row>('SELECT to_jsonb(b) AS value,b.xmin::text AS xmin FROM collaboration_markdown_create_births b WHERE workspace_id=$1 AND operation_id=$2', values)).rows;
      assert.equal(imports.length, 1); assert.equal(births.length, 1);
      const importRow = object(imports[0].value), birth = object(births[0].value), target = object(object(importRow.private_result).target);
      assert.equal(importRow.actor_user_id, identityA.userId); assert.equal(importRow.actor_session_id, identityA.sessionId);
      assert.equal(object(importRow.private_result).sourceHash, sha(original.source)); assert.equal(Number(object(importRow.private_result).sourceBytes), original.source.length);
      assert.equal(target.documentId, r.document_id); assert.equal(target.lineageId, r.lineage_id);
      assert.equal(birth.document_id, r.document_id); assert.equal(Number(birth.finalized), 1);
      assert.equal(birth.revision_id, r.revision_id); assert.equal(birth.serialized_hash, r.sha256);
      const documents = (await database.query<Row>('SELECT to_jsonb(d) AS value,d.xmin::text AS xmin FROM collaboration_documents d WHERE workspace_id=$1 AND (id=$2 OR path=$3) ORDER BY id LIMIT 3', [r.workspace_id, r.document_id, r.path])).rows;
      const lineages = (await database.query<Row>('SELECT to_jsonb(l) AS value,l.xmin::text AS xmin FROM file_collaboration_lineages l WHERE workspace_id=$1 AND (id=$2 OR path=$3) ORDER BY id LIMIT 3', [r.workspace_id, r.lineage_id, r.path])).rows;
      const states = (await database.query<Row>(`SELECT to_jsonb(s)-'yjs_state'-'state_vector' AS value,
        encode(sha256(s.yjs_state),'hex') AS state_sha256,encode(sha256(s.state_vector),'hex') AS vector_sha256,
        octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes,s.xmin::text AS xmin
        FROM collaboration_yjs_states s WHERE workspace_id=$1 AND (document_id=$2 OR path=$3) ORDER BY document_id LIMIT 3`, [r.workspace_id, r.document_id, r.path])).rows;
      const projections = (await database.query<Row>('SELECT to_jsonb(p) AS value,p.xmin::text AS xmin FROM collaboration_file_projections p WHERE document_id=$1', [r.document_id])).rows;
      const revisions = (await database.query<Row>('SELECT to_jsonb(v) AS value,v.xmin::text AS xmin FROM file_revisions v WHERE workspace_id=$1 AND lineage_id=$2 ORDER BY revision_number,id LIMIT 3', [r.workspace_id, r.lineage_id])).rows;
      const history = (await database.query<Row>('SELECT to_jsonb(c) AS value,c.xmin::text AS xmin FROM file_revision_contents c WHERE workspace_id=$1 AND lineage_id=$2 ORDER BY revision_id LIMIT 3', [r.workspace_id, r.lineage_id])).rows;
      const blobs = (await database.query<Row>(`SELECT to_jsonb(b)-'compressed_content' AS value,
        encode(sha256(b.compressed_content),'hex') AS stored_sha256,b.xmin::text AS xmin FROM file_version_blobs b
        JOIN file_revision_contents c ON c.blob_id=b.blob_id AND c.workspace_id=b.workspace_id
        WHERE c.workspace_id=$1 AND c.lineage_id=$2 ORDER BY b.blob_id,c.revision_id LIMIT 3`, [r.workspace_id, r.lineage_id])).rows;
      const metadata = (await database.query<Row>('SELECT to_jsonb(m) AS value,m.xmin::text AS xmin FROM workspace_file_metadata m WHERE workspace_id=$1 AND path=$2 LIMIT 2', [r.workspace_id, r.path])).rows;
      assert(metadata.length <= 1);
      for (const actualRows of [documents, lineages, states, projections, revisions, history, blobs]) assert.equal(actualRows.length, 1);
      assert.equal(object(documents[0].value).provider, 'yjs'); assert.equal(object(documents[0].value).yjs_state_lifecycle, 'initialized');
      assert.equal(object(documents[0].value).lineage_id, r.lineage_id); assert.equal(object(lineages[0].value).status, 'active');
      assert.equal(Number(object(states[0].value).lifecycle_generation), 1); assert.equal(Number(object(states[0].value).document_sequence), 0);
      assert(Number(states[0].state_bytes) <= 2 * 1024 * 1024 && Number(states[0].vector_bytes) <= 128 * 1024);
      assert.equal(Number(object(projections[0].value).finalized), 1); assert.equal(object(projections[0].value).revision_id, r.revision_id);
      assert.equal(object(revisions[0].value).created_by_actor_type, 'agent'); assert.equal(object(revisions[0].value).source_session_id, identityA.sessionId);
      assert.equal(object(revisions[0].value).id, r.revision_id); assert.equal(object(revisions[0].value).content_hash, r.sha256);
      assert.equal(Number(object(revisions[0].value).size_bytes), r.size);
      assert.equal(object(history[0].value).source, 'external_import'); assert.equal(object(history[0].value).lineage_id, r.lineage_id);
      assert.equal(object(blobs[0].value).content_sha256, r.sha256); assert.equal(Number(object(blobs[0].value).raw_size_bytes), r.size);
      const claimPath = path.join(owned.dataRoot, store, String(birth.claim_id), 'intent.json');
      const claim = await ownedFile(claimPath, 128 * 1024), intent = object(JSON.parse(claim.bytes.toString('utf8')));
      const source = object(intent.source), historical = object(intent.origin);
      assert.equal(source.kind, 'direct-mcp-markdown-v1'); assert.equal(source.clientId, mcpA.registration.clientId);
      assert.equal(source.actorUserId, identityA.userId); assert.equal(source.actorSessionId, identityA.sessionId);
      assert.equal(historical.sessionId, identityA.sessionId); assert.equal(historical.clientId, mcpA.registration.clientId);
      assert.equal(Number(historical.databaseOid), Number(owned.databaseOid)); assert.equal(source.sourceHash, sha(original.source));
      assert.equal(source.sourceBytes, original.source.length); assert.equal(source.operationId, r.operation_id);
      assert.equal(source.tool, r.path.endsWith('imported.md') ? 'import_knowledge_file' : 'create_knowledge_source');
      assert.equal(source.fileId, r.path.endsWith('imported.md') ? 'official-mcp-readme-c518f7a9' : null);
      assert.equal(source.declaredMimeType, r.path.endsWith('imported.md') ? 'text/markdown' : null);
      assert.equal(claim.bytes.includes(Buffer.from(sourceUrl)), false); assert.equal(claim.bytes.includes(Buffer.from('download_url')), false);
      const fullPath = path.join(owned.dataRoot, workspace.rootRelativePath, r.path), physical = await ownedFile(fullPath, 512 * 1024);
      assert.deepEqual(physical.bytes, original.source); assert.equal(sha(physical.bytes), r.sha256); assert.equal(physical.bytes.length, r.size);
      rows.push({ imports, births, documents, lineages, states, projections, revisions, history, blobs, metadata,
        claim: { sha256: sha(claim.bytes), identity: claim.identity }, physical: { sha256: sha(physical.bytes), identity: physical.identity } });
    }
    assert.equal((await database.query<Row>('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true);
    await database.query('COMMIT');
  } catch (error) { primary = error; failed = true; }
  let closeFailure: unknown;
  try { await database.end(); assert(ended, 'The actual read-only PG client must emit end.'); } catch (error) { closeFailure = error; }
  if (failed || closeFailure || asyncError) throw new AggregateError([...(failed ? [primary] : []), ...(closeFailure ? [closeFailure] : []), ...(asyncError ? [asyncError] : [])], 'Own read-only original observation failed or did not close.');
  return { rows, probe: { backendPid, readOnly: true, xidUnassigned: true, closed: true } };
}
async function evidence(info: TestInfo, value: Row): Promise<void> {
  await fs.writeFile(info.outputPath('native-mcp-http-evidence.json'), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
}

test.describe.serial('Owned compiled native MCP create/import and renewed OAuth', () => {
  test.beforeAll(async () => {
    owned = await requireOwnedYjsQaTarget(); assert.equal(owned.activeSpec, spec);
    assert.equal(process.env.FILE_VERSION_CENTER_MODE, 'shadow'); assert.equal(process.env.CANVAS_MCP_DIRECT_SETTINGS_SOURCE, 'settings');
    const published = parse(await privateBytes(path.join(owned.fixtureRoot, 'runtime.env')));
    for (const name of ['FILE_VERSION_CENTER_MODE', 'CANVAS_MCP_DIRECT_SETTINGS_SOURCE']) assert.equal(process.env[name], published[name]);
  });
  test.afterAll(async () => {
    const errors: unknown[] = [], active = contextB ?? contextA, current = mcpB ?? mcpA;
    const clean = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { errors.push(error); } };
    // Only after all comparisons: connection revocation affects all this
    // client's sessions, so it must never be used as the A-only revoke step.
    if (current && active) await clean(async () => {
      const connections = async () => {
        const data = object((await ok(await active.request.get('/api/integrations/mcp-server/connections'), 'Observe own OAuth cleanup')).data);
        assert(Array.isArray(data.connections)); return data.connections.map(value => object(value));
      };
      if ((await connections()).some(value => value.connectionId === current.connectionId)) {
        const disconnected = await ok(await active.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId: current.connectionId } }), 'Revoke only own OAuth connection with the active session');
        assert.equal(disconnected.success, true);
      }
      assert(!(await connections()).some(value => value.connectionId === current.connectionId));
    });
    if (active && workspace) await clean(async () => { await ok(await active.request.delete(`/api/workspaces/${encodeURIComponent(workspace!.id)}`), 'Delete only own workspace'); });
    if (active && initialSettings) await clean(async () => {
      await ok(await active.request.patch('/api/integrations/mcp-server', { data: initialSettings }), 'Restore own MCP settings');
      await ok(await active.request.patch('/api/integrations/mcp-server', { data: initialSettings }), 'Restore exact own MCP capability selection');
      await reviewOff(active);
    });
    for (const context of [...contexts].reverse()) {
      if (!signedOut.has(context)) await clean(async () => {
        const value = await ok(await context.request.post('/api/auth/sign-out', { headers: { Origin: origin }, data: {}, maxRedirects: 0 }), 'Sign out only own session');
        assert.equal(value.success, true); signedOut.add(context);
      });
      await clean(() => context.close());
    }
    if (errors.length) throw new AggregateError(errors, 'Own compiled MCP OAuth cleanup remained unconfirmed.');
  });
  test('1: real authorization-code session A creates and HTTPS-imports native documents over compiled MCP HTTP', async ({ browser }, info) => {
    contextA = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, colorScheme: 'light' }); contexts.push(contextA);
    identityA = await login(contextA); await reviewOff(contextA);
    const initial = object((await ok(await contextA.request.get('/api/integrations/mcp-server'), 'Initial MCP status')).data);
    assert.equal(initial.activationManagedByEnvironment, false); assert(Array.isArray(initial.capabilities));
    initialSettings = { enabled: initial.desiredEnabled === true, tools: initial.capabilities.filter(value => object(value).enabled === true).map(value => String(object(value).id)) };
    const configured = object((await ok(await contextA.request.patch('/api/integrations/mcp-server', { data: { enabled: true, tools } }), 'Enable genuine owned MCP')).data);
    assert.equal(configured.runtimeEnabled, true); assert.equal(configured.authentication, 'oauth-2.1-pkce');
    assert(typeof configured.protocolVersion === 'string' && typeof configured.issuer === 'string'); protocol = configured.protocolVersion; issuer = configured.issuer;
    const response = await contextA.request.post('/api/workspaces', { data: { type: 'personal', name: `Native MCP OAuth ${randomUUID()}` } });
    const createdWorkspace = await ok(response, 'Create own workspace'); assert.equal(response.status(), 201);
    const w = object(createdWorkspace.workspace); assert(typeof w.id === 'string' && typeof w.rootRelativePath === 'string' && typeof w.name === 'string');
    workspace = { id: w.id, rootRelativePath: w.rootRelativePath, name: w.name };
    await ok(await contextA.request.put('/api/integrations/mcp-server/workspaces', { data: { workspaceId: workspace.id, enabled: true } }), 'Opt in owned workspace');
    mcpA = await authorizeIngestE2EMcp(contextA, origin, workspace.id, protocol, { scopes, clientNamePrefix: 'Owned native MCP compiled' });
    tokenIdentity(mcpA, identityA); assert.equal(success(await mcpA.call('auth_probe', {})).authenticated, true);
    const discovered = await mcpA.rpc('server/discover');
    assert.notEqual(discovered.isError, true, 'Modern MCP discovery must succeed.');
    assert(Array.isArray(discovered.supportedVersions) && discovered.supportedVersions.every(value => typeof value === 'string'));
    assert(discovered.supportedVersions.includes(protocol));
    assert(object(object(discovered.capabilities).tools));
    assert.equal(object(object(discovered._meta)['io.modelcontextprotocol/serverInfo']).name, 'canvas-notebook-direct-mcp');
    const listing = await mcpA.rpc('tools/list'); assert(Array.isArray(listing.tools));
    for (const name of tools) assert(listing.tools.some(value => object(value).name === name));
    const generated = Buffer.from('# Native compiled MCP\n\nReal complete **content**.\n');
    const generatedReceipt = fileReceipt(await mcpA.call('create_knowledge_source', { workspace_id: workspace.id,
      path: 'oauth/generated.md', content: generated.toString('utf8'), idempotency_key: `generated-${randomUUID()}` }));
    assert.equal(generatedReceipt.status, 'created');
    const source = await fetch(sourceUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) }); assert(source.body);
    const reader = source.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { assert.equal(source.status, 200); assert.equal(source.url, sourceUrl);
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; assert(size <= 10_000); chunks.push(part.value); }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    const sourceBytes = Buffer.concat(chunks); assert(sourceBytes.length >= 128);
    const sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes);
    assert(Buffer.from(sourceText).equals(sourceBytes)); assert(sourceText.includes('# Model Context Protocol (MCP)'));
    importArgs = { workspace_id: workspace.id, path: 'oauth/imported.md', idempotency_key: `imported-${randomUUID()}`,
      file: { download_url: sourceUrl, file_id: 'official-mcp-readme-c518f7a9', file_name: 'README.md', mime_type: 'text/markdown' } };
    const imported = fileReceipt(await mcpA.call('import_knowledge_file', importArgs)); assert.equal(imported.status, 'created');
    originals = [{ receipt: generatedReceipt, source: generated, native: await nativeRead(mcpA, generatedReceipt) },
      { receipt: imported, source: sourceBytes, native: await nativeRead(mcpA, imported) }];
    const captured = await snapshotOriginals(); before = captured.rows; await reviewOff(contextA);
    await evidence(info, { scope: 'actual compiled HTTP and real authorization-code session A', count: originals.length,
      sourceSha256: sha(sourceBytes), sourceBytes: sourceBytes.length, nativeVersions: originals.map(value => value.native.document.version), readOnlyProbe: captured.probe });
  });
  test('2: fresh browser login B reauthorizes the SAME client while the unchanged A token is rejected', async ({ browser }, info) => {
    assert(contextA && mcpA && identityA && workspace && originals.length === 2);
    const signed = await ok(await contextA.request.post('/api/auth/sign-out', { headers: { Origin: origin }, data: {}, maxRedirects: 0 }), 'Revoke actual session A');
    assert.equal(signed.success, true); signedOut.add(contextA);
    const rejected = await mcpA.call('auth_probe', {}); assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent?.http_status, 401); assert.match(String(rejected.structuredContent?.authentication_challenge), /invalid_token/u);
    contextB = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, colorScheme: 'light' }); contexts.push(contextB);
    identityB = await login(contextB); assert.equal(identityB.userId, identityA.userId); assert.notEqual(identityB.sessionId, identityA.sessionId);
    mcpB = await authorizeIngestE2EMcp(contextB, origin, workspace.id, protocol, { scopes, registration: mcpA.registration });
    assert.deepEqual(mcpB.registration, mcpA.registration); tokenIdentity(mcpB, identityB);
    assert.equal(success(await mcpB.call('auth_probe', {})).authenticated, true);
    const stillA = await mcpA.call('auth_probe', {}); assert.equal(stillA.isError, true); assert.equal(stillA.structuredContent?.http_status, 401);
    for (const original of originals) {
      const current = await nativeRead(mcpB, original.receipt, original.native.document.version);
      assert.deepEqual(current.document, original.native.document); assert.equal(current.fragment, original.native.fragment);
    }
    await reviewOff(contextB); await evidence(info, { scope: 'new real login/code exchange B, same registration, A HTTP401', sameClient: true,
      differentRealSessions: true, oldTokenRejectedBeforeAndAfterB: true });
  });
  test('3: session B completed Bad-URL retry preserves original A native identity, full version and all original xmin', async ({ browser: _browser }, info) => {
    assert(contextB && mcpB && mcpA && identityA && identityB && workspace && importArgs && before && originals.length === 2);
    const imported = originals[1], replacement = { ...importArgs, file: { ...object(importArgs.file), download_url: 'https://127.0.0.1:1/expired-reference' } };
    const retry = fileReceipt(await mcpB.call('import_knowledge_file', replacement));
    assert.deepEqual(retry, { ...imported.receipt, status: 'already_created' });
    const current = await nativeRead(mcpB, retry, imported.native.document.version);
    assert.deepEqual(current.document, imported.native.document); assert.deepEqual(current.currency, imported.native.currency); assert.equal(current.fragment, imported.native.fragment);
    const after = await snapshotOriginals(); assert.deepEqual(after.rows, before);
    await reviewOff(contextB); await evidence(info, { scope: 'completed original source/history untouched by B with unusable URL', originalRowsUnchanged: true,
      noDownloadRequired: true, historySource: 'external_import', historyAttributedToOriginalA: true, fullVersion: current.document.version, readOnlyProbe: after.probe });
  });
});
