import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { expect, request as apiRequest, test, type APIRequestContext, type APIResponse, type BrowserContext, type TestInfo } from '@playwright/test';
import type { DocumentCreateMutationResultV1, DocumentReadPageV1 } from '../app/lib/documents/contracts';
import type { DocumentEditOperationResultV1 } from '../app/lib/documents/edit-result-contract';
import type { NativeDocumentEditTargetV1 } from '../app/lib/collaboration/native-document-edit-targets';
import type { DirectMcpFileReceipt } from '../app/lib/mcp/server/file-ingest';
import { authorizeIngestE2EMcp, type IngestE2EToolResult } from '../scripts/mcp-file-ingest-e2e-helpers';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { assertDatabaseOwnership, assertOwnedRoot, privateBytes, requireOwnedYjsQaTarget,
  type DatabaseIdentity, type OwnedYjsReceipt } from '../scripts/lib/owned-yjs-authority-qa';

// Artifact options are worker-scoped and must be set at file level. This
// serial workflow shares manually created authenticated contexts; keep OAuth
// URLs out of automatic artifacts in all seven cases. Explicit safe editor
// screenshots remain available and all domain assertions are unchanged.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// The existing supervisor alone owns the actual compiled production host,
// issuer, DB and browser process. Every write/authorization crosses real HTTP.
const spec = 'tests/direct-mcp-native-create-import.spec.ts';
const origin = process.env.BASE_URL ?? '';
const sourceUrl = 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/c518f7a927cff918bce35d3522fcdb046d264d7c/README.md';
const tools = ['auth_probe', 'create_knowledge_source', 'import_knowledge_file', 'read_knowledge_source', 'edit_knowledge_source'];
const scopes = ['openid', 'offline_access', 'workspace:list', 'knowledge:read', 'knowledge:write'];
type Row = Record<string, unknown>;
type Mcp = Awaited<ReturnType<typeof authorizeIngestE2EMcp>>;
type Identity = Readonly<{ userId: string; sessionId: string }>;
type Workspace = Readonly<{ id: string; name: string; rootRelativePath: string }>;
type Original = Readonly<{ receipt: DirectMcpFileReceipt; mutation: DocumentCreateMutationResultV1; source: Buffer; native: DocumentReadPageV1 }>;
type Probe = Readonly<{ backendPid: number; readOnly: true; xidUnassigned: true; closed: true }>;
const contexts: BrowserContext[] = [], signedOut = new Set<BrowserContext>();
let owned: OwnedYjsReceipt, contextA: BrowserContext | undefined, contextB: BrowserContext | undefined;
let mcpA: Mcp | undefined, mcpB: Mcp | undefined, identityA: Identity | undefined, identityB: Identity | undefined;
let workspace: Workspace | undefined, protocol = '', issuer = '', importArgs: Row | undefined, generatedArgs: Row | undefined;
let initialSettings: { enabled: boolean; tools: string[] } | undefined;
let originals: Original[] = [], before: Row[] | undefined;
const editApiContexts: APIRequestContext[] = [], editorSelector = '.tiptap-editor-shell .ProseMirror';
let editCreated: DocumentCreateMutationResultV1 | undefined, editRequest: Row | undefined;
let firstEdit: DocumentEditOperationResultV1 | undefined, firstEditOrigin: Identity | undefined, editSnapshot: Row | undefined;
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
function mutationResult(result: IngestE2EToolResult): DocumentCreateMutationResultV1 {
  const value = success(result); assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse(result.content[0].text ?? ''), value);
  assert.deepEqual(Object.keys(value).sort(), ['apiVersion', 'operationId', 'outcome', 'document', 'currency', 'projection'].sort());
  assert.equal(value.apiVersion, 1); assert(typeof value.operationId === 'string' && value.operationId);
  assert(['created', 'already_created'].includes(String(value.outcome)));
  assert.match(String(object(value.document).version), /^canvas-document-v1:[a-f0-9]{64}$/u);
  assert.match(String(object(value.document).metadataVersion), /^canvas-document-metadata-v1:[a-f0-9]{64}$/u);
  return value as unknown as DocumentCreateMutationResultV1;
}
function mutationMatchesRead(mutation: DocumentCreateMutationResultV1, receipt: DirectMcpFileReceipt, page: DocumentReadPageV1): void {
  assert.equal(mutation.operationId, receipt.operation_id);
  assert.deepEqual(mutation.document, page.document); assert.deepEqual(mutation.currency, page.currency); assert.deepEqual(mutation.projection, page.projection);
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

// New public Edit acceptance helpers. These observe genuine results; no
// server-only encoder, private Original or credentials become caller authority.
function editResultValue(value: unknown): DocumentEditOperationResultV1 {
  const row = object(value);
  assert.deepEqual(Object.keys(row).sort(), ['apiVersion', 'operationId', 'state', 'document', 'effect', 'persistence', 'projection', 'history'].sort());
  assert.equal(row.apiVersion, 1); assert.equal(row.state, 'confirmed'); assert.match(String(row.operationId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  const document = object(row.document), effect = object(row.effect), persistence = object(row.persistence);
  assert.deepEqual(Object.keys(document).sort(), ['kind', 'workspaceId', 'organizationId', 'documentId', 'lineageId', 'lifecycleGeneration', 'representation', 'schemaVersion'].sort());
  assert.equal(document.kind, 'native_document'); assert.equal(document.workspaceId, workspace!.id);
  assert.equal(effect.outcome, 'applied'); assert.match(String(effect.beforeVersion), /^canvas-document-v1:[a-f0-9]{64}$/u);
  assert.match(String(effect.afterVersion), /^canvas-document-v1:[a-f0-9]{64}$/u); assert.notEqual(effect.afterVersion, effect.beforeVersion);
  assert(Number.isSafeInteger(effect.appliedAt)); assert.equal(persistence.status, 'confirmed'); assert(Number.isSafeInteger(persistence.confirmedInSequence));
  assert(Number.isSafeInteger(persistence.confirmedAt)); assert(Buffer.byteLength(JSON.stringify(row)) <= 8192);
  for (const key of ['original', 'after', 'origin', 'actor', 'targets', 'stateProof', 'yjsState', 'stateVector', 'rootPath', 'sessionId']) assert.equal(Object.hasOwn(row, key), false);
  return row as unknown as DocumentEditOperationResultV1;
}
function editResult(result: IngestE2EToolResult): DocumentEditOperationResultV1 {
  const row = success(result); assert(Array.isArray(result.content)); assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse(result.content[0].text ?? ''), row); return editResultValue(row);
}
async function editRead(client: Mcp, expectedVersion?: string, targets = false): Promise<DocumentReadPageV1> {
  assert(editCreated);
  const page = success(await client.call('read_knowledge_source', { workspace_id: editCreated.document.workspaceId,
    document_id: editCreated.document.documentId, format: 'native', max_bytes: 262144,
    ...(expectedVersion ? { expected_version: expectedVersion } : {}), ...(targets ? { include_edit_targets: true } : {}) })) as unknown as DocumentReadPageV1;
  assert.equal(page.apiVersion, 1); assert.equal(page.format, 'native'); assert.equal(page.encoding, 'utf-8');
  for (const key of ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'representation', 'lifecycleGeneration', 'schemaVersion'] as const) assert.equal(page.document[key], editCreated.document[key]);
  assert.equal(page.document.representation, 'tiptap_blocks'); assert.equal(page.currency.observedDurable, true);
  assert.equal(page.currency.observedVersion, page.document.version); assert.equal(page.currency.durableVersion, page.document.version);
  assert.equal(page.byteOffset, 0); assert.equal(page.byteLength, Buffer.byteLength(page.fragment)); assert.equal(page.totalBytes, page.byteLength);
  assert.equal(page.complete, true); assert.equal(page.nextCursor, null);
  if (expectedVersion) assert.equal(page.document.version, expectedVersion);
  const body = object(JSON.parse(page.fragment)); assert.equal(body.bodyVersion, 1); assert.equal(object(body.content).kind, 'rich_text');
  assert.equal(Object.hasOwn(body, 'editTargets'), targets); return page;
}
function nativeJson(page: DocumentReadPageV1): Row { return object(object(object(JSON.parse(page.fragment)).content).document); }
function editMatchesRead(edited: DocumentEditOperationResultV1, page: DocumentReadPageV1): void {
  assert(edited.effect);
  for (const key of ['documentId', 'lineageId', 'workspaceId', 'organizationId', 'representation', 'lifecycleGeneration', 'schemaVersion'] as const) assert.equal(edited.document[key], page.document[key]);
  assert.equal(edited.effect.afterVersion, page.document.version); assert(page.currency.durableSequence! >= edited.persistence.confirmedInSequence!);
}
function statusArgs(operationId: string): Row { return { api_version: 1, action: 'status', workspace_id: workspace!.id, operation_id: operationId }; }

/** Fresh bounded READ ONLY evidence under the actual owned database. No
 * session/table writes or operation reconciliation are performed here. */
async function editRows(): Promise<{ rows: Row; released: boolean; probe: Probe }> {
  await requireOwnedYjsQaTarget(); assert(workspace && editCreated);
  const selected = editCreated.document, database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c application_name=native-edit-compiled-read' });
  let ended = false, asynchronous: Error | undefined, failure: unknown, failed = false, backendPid = 0;
  let captured: Row | undefined, released = false;
  database.once('end', () => { ended = true; }); database.on('error', error => { asynchronous ??= error; });
  try {
    await database.connect(); await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = (await database.query<Row>(`SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba) AS owner,
      current_user AS role,shobj_description(d.oid,'pg_database') AS marker,pg_backend_pid() AS pid,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
      pg_current_xact_id_if_assigned() IS NULL AS unassigned FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert(actual); assertDatabaseOwnership(owned, actual as unknown as DatabaseIdentity);
    assert.equal(actual.read_only, 'on'); assert.equal(actual.isolation, 'repeatable read'); assert.equal(actual.unassigned, true);
    assert(typeof actual.pid === 'number'); backendPid = actual.pid;
    const scope = [selected.workspaceId, selected.documentId], documents = (await database.query<Row>('SELECT to_jsonb(d) AS value,d.xmin::text AS xmin FROM collaboration_documents d WHERE workspace_id=$1 AND id=$2', scope)).rows;
    const lineages = (await database.query<Row>('SELECT to_jsonb(l) AS value,l.xmin::text AS xmin FROM file_collaboration_lineages l WHERE workspace_id=$1 AND id=$2', [selected.workspaceId, selected.lineageId])).rows;
    const states = (await database.query<Row>(`SELECT to_jsonb(s)-'yjs_state'-'state_vector' AS value,s.xmin::text AS xmin,
      encode(sha256(s.yjs_state),'hex') AS state_sha256,encode(sha256(s.state_vector),'hex') AS vector_sha256
      FROM collaboration_yjs_states s WHERE workspace_id=$1 AND document_id=$2`, scope)).rows;
    for (const result of [documents, lineages, states]) assert.equal(result.length, 1);
    const state = object(states[0].value); assert.equal(state.status, 'active'); assert.equal(state.representation, 'tiptap_blocks');
    const operations = (await database.query<Row>(`SELECT to_jsonb(o)-'resulting_state_snapshot'-'base_state_vector' AS value,o.xmin::text AS xmin,
      encode(sha256(o.resulting_state_snapshot),'hex') AS after_sha256,encode(sha256(o.base_state_vector),'hex') AS base_vector_sha256
      FROM collaboration_agent_operations o WHERE workspace_id=$1 AND document_id=$2 ORDER BY operation_id LIMIT 9`, scope)).rows;
    assert(operations.length <= 8); assert(operations.every(row => object(row.value).native_edit_original_json));
    const payloads = (await database.query<Row>(`SELECT to_jsonb(p)-'yjs_update' AS value,p.xmin::text AS xmin,encode(sha256(p.yjs_update),'hex') AS update_sha256
      FROM collaboration_agent_native_edit_payloads p JOIN collaboration_agent_operations o USING(operation_id)
      WHERE o.workspace_id=$1 AND o.document_id=$2 ORDER BY p.operation_id LIMIT 9`, scope)).rows; assert(payloads.length <= 8);
    const revisions = (await database.query<Row>('SELECT to_jsonb(r) AS value,r.xmin::text AS xmin FROM file_revisions r WHERE workspace_id=$1 AND lineage_id=$2 ORDER BY id LIMIT 17', [selected.workspaceId, selected.lineageId])).rows; assert(revisions.length <= 16);
    const contents = (await database.query<Row>('SELECT to_jsonb(c) AS value,c.xmin::text AS xmin FROM file_revision_contents c WHERE workspace_id=$1 AND lineage_id=$2 ORDER BY revision_id LIMIT 17', [selected.workspaceId, selected.lineageId])).rows; assert(contents.length <= 16);
    const blobs = (await database.query<Row>(`SELECT to_jsonb(b)-'compressed_content' AS value,b.xmin::text AS xmin,encode(sha256(b.compressed_content),'hex') AS stored_sha256
      FROM file_version_blobs b JOIN file_revision_contents c ON c.blob_id=b.blob_id AND c.workspace_id=b.workspace_id
      WHERE c.workspace_id=$1 AND c.lineage_id=$2 ORDER BY b.blob_id,c.revision_id LIMIT 17`, [selected.workspaceId, selected.lineageId])).rows; assert(blobs.length <= 16);
    const projections = (await database.query<Row>('SELECT to_jsonb(p) AS value,p.xmin::text AS xmin FROM collaboration_file_projections p WHERE document_id=$1', [selected.documentId])).rows;
    const metadata = (await database.query<Row>('SELECT to_jsonb(m) AS value,m.xmin::text AS xmin FROM workspace_file_metadata m WHERE workspace_id=$1 AND path=$2', [selected.workspaceId, selected.path])).rows; assert(metadata.length <= 1);
    const key = sha(`canvas.collaboration.room-owner.v1\0${selected.documentId}`).slice(0, 16);
    const locked = (await database.query<Row>(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=1) AS held`,
    [Number.parseInt(key.slice(0, 8), 16), Number.parseInt(key.slice(8), 16)])).rows[0].held;
    released = state.room_owner_token === null && state.room_owner_backend_pid === null && state.room_owner_backend_start === null && locked === false;
    captured = { documents, lineages, states, operations, payloads, revisions, contents, blobs, projections, metadata };
    assert.equal((await database.query<Row>('SELECT pg_current_xact_id_if_assigned() IS NULL AS unassigned')).rows[0].unassigned, true); await database.query('COMMIT');
  } catch (error) { failure = error; failed = true; }
  let closeFailure: unknown;
  try { await database.end(); assert(ended); } catch (error) { closeFailure = error; }
  if (failed || closeFailure || asynchronous) throw new AggregateError([...(failed ? [failure] : []), ...(closeFailure ? [closeFailure] : []), ...(asynchronous ? [asynchronous] : [])], 'Owned native Edit read-only evidence or close failed.');
  assert(captured); return { rows: captured, released, probe: { backendPid, readOnly: true, xidUnassigned: true, closed: true } };
}
async function releasedEditRows(): Promise<{ rows: Row; probe: Probe }> {
  await expect.poll(async () => (await editRows()).released, { timeout: 40000, intervals: [500, 1000, 2000] }).toBe(true);
  const observed = await editRows(); assert(observed.released); return observed;
}
function assertRecordedEdit(rows: Row, edited: DocumentEditOperationResultV1, origin: Identity, transport: 'request' | 'direct-mcp'): void {
  assert(Array.isArray(rows.operations)); const operation = object(object(rows.operations.find(entry => object(object(entry).value).operation_id === edited.operationId)).value);
  const original = object(operation.native_edit_original_json), actor = object(original.actor), actualOrigin = object(original.origin), after = object(operation.native_edit_after_json);
  assert.equal(actor.userId, origin.userId); assert.equal(actor.sessionId, origin.sessionId); assert.equal(actualOrigin.transport, transport);
  assert.equal(actualOrigin.sessionId, origin.sessionId); assert.equal(operation.actor_session_id, origin.sessionId);
  assert.equal(operation.initiated_by_user_id, origin.userId); assert.equal(operation.actor_id, actor.actorId);
  assert.equal(operation.document_id, edited.document.documentId); assert.equal(object(original.identity).lineageId, edited.document.lineageId);
  assert.equal(actor.actorType, transport === 'request' ? 'user' : 'agent'); assert.equal(actualOrigin.userId, origin.userId);
  if (transport === 'direct-mcp') assert.equal(actualOrigin.clientId, mcpA!.registration.clientId);
  else { assert.equal(actor.actorId, origin.userId); assert.equal(Object.hasOwn(actualOrigin, 'clientId'), false); }
  assert.equal(after.beforeVersion, edited.effect!.beforeVersion); assert.equal(after.afterVersion, edited.effect!.afterVersion);
  assert.equal(after.originalProof, original.originalProof); assert.equal(operation.applied_at, edited.effect!.appliedAt);
  assert(Array.isArray(rows.payloads)); assert(rows.payloads.some(entry => object(object(entry).value).operation_id === edited.operationId));
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
    for (const request of editApiContexts) await clean(() => request.dispose());
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
    generatedArgs = { workspace_id: workspace.id, path: 'oauth/generated.md', content: generated.toString('utf8'), idempotency_key: `generated-${randomUUID()}` };
    const generatedReceipt = fileReceipt(await mcpA.call('create_knowledge_source', generatedArgs));
    assert.equal(generatedReceipt.status, 'created');
    const generatedMutation = mutationResult(await mcpA.call('create_knowledge_source', { ...generatedArgs, api_version: 1 }));
    assert.equal(generatedMutation.outcome, 'already_created');
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
    const importedMutation = mutationResult(await mcpA.call('import_knowledge_file', { ...importArgs, api_version: 1 }));
    assert.equal(importedMutation.outcome, 'created');
    const imported = fileReceipt(await mcpA.call('import_knowledge_file', importArgs)); assert.equal(imported.status, 'already_created');
    originals = [{ receipt: generatedReceipt, mutation: generatedMutation, source: generated,
      native: await nativeRead(mcpA, generatedReceipt, generatedMutation.document.version) },
    { receipt: imported, mutation: importedMutation, source: sourceBytes,
      native: await nativeRead(mcpA, imported, importedMutation.document.version) }];
    for (const original of originals) mutationMatchesRead(original.mutation, original.receipt, original.native);
    const captured = await snapshotOriginals(); before = captured.rows; await reviewOff(contextA);
    await evidence(info, { scope: 'actual compiled HTTP and real authorization-code session A', count: originals.length,
      sourceSha256: sha(sourceBytes), sourceBytes: sourceBytes.length, nativeVersions: originals.map(value => value.native.document.version), readOnlyProbe: captured.probe,
      mutationApiVersion: 1, metadataVersions: originals.map(value => value.mutation.document.metadataVersion),
      mutationOutcomes: originals.map(value => value.mutation.outcome), sameKeyLegacyReceiptsRetained: true });
  });
  test('2: fresh browser login B reauthorizes the SAME client while the unchanged A token is rejected', async ({ browser }, info) => {
    assert(contextA && mcpA && identityA && workspace && generatedArgs && originals.length === 2);
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
    const renewedMutation = mutationResult(await mcpB.call('create_knowledge_source', { ...generatedArgs, api_version: 1 }));
    assert.deepEqual(renewedMutation, originals[0].mutation);
    for (const original of originals) {
      const mutation = original === originals[0] ? renewedMutation : original.mutation;
      const current = await nativeRead(mcpB, original.receipt, mutation.document.version);
      mutationMatchesRead(mutation, original.receipt, current);
      assert.deepEqual(current.document, original.native.document); assert.equal(current.fragment, original.native.fragment);
    }
    await reviewOff(contextB); await evidence(info, { scope: 'new real login/code exchange B, same registration, A HTTP401', sameClient: true,
      differentRealSessions: true, oldTokenRejectedBeforeAndAfterB: true, mutationApiVersion: 1, renewedMutationResultIdentical: true });
  });
  test('3: session B completed Bad-URL retry preserves original A native identity, full version and all original xmin', async ({ browser: _browser }, info) => {
    assert(contextB && mcpB && mcpA && identityA && identityB && workspace && importArgs && before && originals.length === 2);
    const imported = originals[1], replacement = { ...importArgs, file: { ...object(importArgs.file), download_url: 'https://127.0.0.1:1/expired-reference' } };
    const retryMutation = mutationResult(await mcpB.call('import_knowledge_file', { ...replacement, api_version: 1 }));
    assert.deepEqual(retryMutation, { ...imported.mutation, outcome: 'already_created' });
    const retry = fileReceipt(await mcpB.call('import_knowledge_file', replacement));
    assert.deepEqual(retry, { ...imported.receipt, status: 'already_created' });
    const current = await nativeRead(mcpB, retry, retryMutation.document.version); mutationMatchesRead(retryMutation, retry, current);
    assert.deepEqual(current.document, imported.native.document); assert.deepEqual(current.currency, imported.native.currency); assert.equal(current.fragment, imported.native.fragment);
    const after = await snapshotOriginals(); assert.deepEqual(after.rows, before);
    await reviewOff(contextB); await evidence(info, { scope: 'completed original source/history untouched by B with unusable URL', originalRowsUnchanged: true,
      noDownloadRequired: true, historySource: 'external_import', historyAttributedToOriginalA: true, fullVersion: current.document.version, readOnlyProbe: after.probe,
      mutationApiVersion: 1, metadataVersion: current.document.metadataVersion, legacySameKeyReceiptUnchanged: true });
  });
  test('4: compiled OAuth MCP edit reaches the open native editor and same-key/status preserve its actual operation', async ({ browser: _browser }, info) => {
    assert(contextB && mcpB && identityB && workspace);
    firstEditOrigin = identityB;
    const source = '# Compiled native edit\n\nOAuth edit target 😀.\n\nMove this paragraph 🧪.\n\nKeep final tail.\n';
    editCreated = mutationResult(await mcpB.call('create_knowledge_source', { api_version: 1, workspace_id: workspace.id,
      path: 'oauth/native-edit.md', content: source, idempotency_key: `public-edit-create-${randomUUID()}` }));
    assert.equal(editCreated.outcome, 'created'); assert.equal(editCreated.document.representation, 'tiptap_blocks');
    const initial = await editRead(mcpB, editCreated.document.version);
    assert.deepEqual(initial.document, editCreated.document); assert.deepEqual(initial.currency, editCreated.currency); assert.deepEqual(initial.projection, editCreated.projection);
    const page = await contextB.newPage();
    try {
      await page.addInitScript(({ id, host }) => { if (location.origin === host) { localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false'); } }, { id: workspace.id, host: origin });
      await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(editCreated.document.path)}`, { waitUntil: 'domcontentloaded' });
      const editor = page.locator(editorSelector); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 90000 });
      await expect(editor).toBeVisible();
      await expect(editor).toContainText('OAuth edit target 😀.');
      await expect.poll(async () => (await readNativeRichCandidate(page, editorSelector)).document, { timeout: 45000 }).toEqual(nativeJson(initial));
      editRequest = { api_version: 1, action: 'edit', workspace_id: workspace.id, document_id: editCreated.document.documentId,
        expected_version: initial.document.version, idempotency_key: `public-edit-text-${randomUUID()}`,
        patch: { kind: 'native_text_replace', edits: [{ oldText: 'OAuth edit target', newText: 'MCP changed target', expectedOccurrences: 1 }] } };
      firstEdit = editResult(await mcpB.call('edit_knowledge_source', editRequest)); assert.equal(firstEdit.effect!.beforeVersion, initial.document.version);
      const after = await editRead(mcpB, firstEdit.effect!.afterVersion); editMatchesRead(firstEdit, after);
      assert(JSON.stringify(nativeJson(after)).includes('MCP changed target 😀.')); assert(!JSON.stringify(nativeJson(after)).includes('OAuth edit target'));
      await expect(editor).toBeVisible(); await expect(editor).toContainText('MCP changed target 😀.'); await expect(editor).not.toContainText('OAuth edit target');
      await expect.poll(async () => (await readNativeRichCandidate(page, editorSelector)).document, { timeout: 45000 }).toEqual(nativeJson(after));
      await page.screenshot({ path: info.outputPath('native-edit-mcp-live-editor.png'), animations: 'disabled' });
    } finally { await page.close(); }
    assert(firstEdit && editRequest);
    const prior = await releasedEditRows(); assertRecordedEdit(prior.rows, firstEdit, firstEditOrigin, 'direct-mcp');
    assert.equal((prior.rows.operations as unknown[]).length, 1);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', editRequest)), firstEdit);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', statusArgs(firstEdit.operationId))), firstEdit);
    const observed = await releasedEditRows(); assert.deepEqual(observed.rows, prior.rows); editSnapshot = observed.rows;
    await reviewOff(contextB); await evidence(info, { scope: 'compiled native MCP CreateV1/Read/Edit/Status with live Hocuspocus editor',
      actualNativeEdit: true, nativeOnlyIdAndFullVersion: true, editorObservedSameNativeJson: true, sameKeyNoReplay: true,
      statusAndRetryRowsUnchanged: true, operationId: firstEdit.operationId, fullVersion: firstEdit.effect!.afterVersion, readOnlyProbe: observed.probe });
  });
  test('5: renewed OAuth session retains native edit Original A and read targets drive a real versioned block move', async ({ browser }, info) => {
    assert(contextB && mcpB && identityB && workspace && editCreated && firstEdit && editRequest && firstEditOrigin && editSnapshot);
    const originalContext = contextB, originalClient = mcpB, originalIdentity = identityB;
    assert.equal(originalIdentity.sessionId, firstEditOrigin.sessionId);
    const signed = await ok(await originalContext.request.post('/api/auth/sign-out', { headers: { Origin: origin }, data: {}, maxRedirects: 0 }), 'Expire actual native edit Origin A session');
    assert.equal(signed.success, true); signedOut.add(originalContext);
    const deniedA = await originalClient.call('edit_knowledge_source', statusArgs(firstEdit.operationId));
    assert.equal(deniedA.isError, true); assert.equal(deniedA.structuredContent?.http_status, 401);
    contextB = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, colorScheme: 'light' }); contexts.push(contextB);
    identityB = await login(contextB); assert.equal(identityB.userId, originalIdentity.userId); assert.notEqual(identityB.sessionId, originalIdentity.sessionId);
    mcpB = await authorizeIngestE2EMcp(contextB, origin, workspace.id, protocol, { scopes, registration: originalClient.registration });
    assert.deepEqual(mcpB.registration, originalClient.registration); tokenIdentity(mcpB, identityB);
    assert.equal(success(await mcpB.call('auth_probe', {})).authenticated, true);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', editRequest)), firstEdit);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', statusArgs(firstEdit.operationId))), firstEdit);
    const renewed = await releasedEditRows(); assert.deepEqual(renewed.rows, editSnapshot); assertRecordedEdit(renewed.rows, firstEdit, firstEditOrigin, 'direct-mcp');
    const stillA = await originalClient.call('edit_knowledge_source', editRequest); assert.equal(stillA.isError, true); assert.equal(stillA.structuredContent?.http_status, 401);
    const beforeMove = await editRead(mcpB, firstEdit.effect!.afterVersion, true), body = object(JSON.parse(beforeMove.fragment));
    assert(Array.isArray(body.editTargets)); const targets = body.editTargets as NativeDocumentEditTargetV1[];
    for (const target of targets) { assert.match(target.placementHash, /^[a-f0-9]{64}$/u); assert.equal(Object.hasOwn(target, 'text'), false); assert.equal(Object.hasOwn(target, 'operations'), false); }
    const doc = nativeJson(beforeMove); assert(Array.isArray(doc.content)); const children = doc.content.map(value => object(value));
    const inlineText = (node: Row) => { assert(Array.isArray(node.content)); return node.content.map(child => String(object(child).text ?? '')).join(''); };
    const movingNode = children.find(node => node.type === 'paragraph' && inlineText(node) === 'Move this paragraph 🧪.');
    const beforeNode = children.find(node => node.type === 'paragraph' && inlineText(node) === 'MCP changed target 😀.'); assert(movingNode && beforeNode);
    const movingId = object(movingNode.attrs).id, beforeId = object(beforeNode.attrs).id; assert(typeof movingId === 'string' && typeof beforeId === 'string');
    const moving = targets.find(target => target.id === movingId); assert(moving && moving.parentId === null);
    const moveRequest = { api_version: 1, action: 'edit', workspace_id: workspace.id, document_id: editCreated.document.documentId,
      expected_version: beforeMove.document.version, idempotency_key: `public-edit-move-${randomUUID()}`,
      patch: { kind: 'native_blocks', operations: [{ kind: 'move_block', blockId: moving.id, placementHash: moving.placementHash, parentId: null, beforeId }] } };
    const moved = editResult(await mcpB.call('edit_knowledge_source', moveRequest)); assert.equal(moved.effect!.beforeVersion, beforeMove.document.version);
    const afterMove = await editRead(mcpB, moved.effect!.afterVersion, true); editMatchesRead(moved, afterMove);
    const expectedChildren = children.filter(node => object(node.attrs).id !== movingId), destination = expectedChildren.findIndex(node => object(node.attrs).id === beforeId);
    assert(destination >= 0); expectedChildren.splice(destination, 0, movingNode);
    assert.deepEqual(nativeJson(afterMove), { ...doc, content: expectedChildren });
    const prior = await releasedEditRows(); assertRecordedEdit(prior.rows, moved, identityB, 'direct-mcp'); assert.equal((prior.rows.operations as unknown[]).length, 2);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', moveRequest)), moved);
    assert.deepEqual(editResult(await mcpB.call('edit_knowledge_source', statusArgs(moved.operationId))), moved);
    assert.deepEqual((await releasedEditRows()).rows, prior.rows);
    await reviewOff(contextB); await evidence(info, { scope: 'same real OAuth client/new SID, expired origin rejected, guarded native block move',
      sameClient: true, oldEditTokenRejectedBeforeAndAfterRenewal: true, originalEditRowsUnchangedByRenewedRetry: true,
      nativeReadTargetsUsed: true, actualBlockMove: true, completeNativeDocumentMatchesExpectedMove: true, movedOperationId: moved.operationId,
      fullVersion: moved.effect!.afterVersion, readOnlyProbe: prior.probe });
  });
  test('6: issued cookie-free session Bearer edits through REST and real sign-out revokes Edit and Status', async ({ browser }, info) => {
    assert(contextB && mcpB && identityB && workspace && editCreated);
    const web = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, colorScheme: 'light' }); contexts.push(web);
    const email = process.env.TEST_LOGIN_EMAIL, password = process.env.TEST_LOGIN_PASSWORD; assert(email && password);
    const signIn = await web.request.post('/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email, password }, maxRedirects: 0 });
    await ok(signIn, 'Fresh REST owner login'); let bearer = signIn.headers()['set-auth-token'] ?? '';
    assert(bearer && bearer.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(bearer), 'The actual login must issue a bounded Session Bearer.');
    const session = await ok(await web.request.get('/api/auth/get-session'), 'Actual REST login identity');
    const restUserId = object(session.user).id, restSessionId = object(session.session).id;
    assert(typeof restUserId === 'string' && restUserId); assert(typeof restSessionId === 'string' && restSessionId);
    const restIdentity = { userId: restUserId, sessionId: restSessionId };
    assert.equal(restIdentity.userId, identityB.userId); assert.notEqual(restIdentity.sessionId, identityB.sessionId);
    const rest = await apiRequest.newContext({ baseURL: origin, timeout: 30000, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Authorization: `Bearer ${bearer}` } });
    bearer = ''; editApiContexts.push(rest);
    const bearerSession = await ok(await rest.get('/api/auth/get-session'), 'Cookie-free actual Bearer identity');
    assert.equal(object(bearerSession.user).id, restIdentity.userId); assert.equal(object(bearerSession.session).id, restIdentity.sessionId);
    assert.deepEqual((await rest.storageState()).cookies, []); assert.deepEqual((await rest.storageState()).origins, []);
    const beforeRest = await editRead(mcpB);
    const searchRequest = { apiVersion: 1, workspaceId: workspace.id, query: 'Keep final tail', limit: 25 };
    const searchResponse = await rest.post('/api/documents/search', { data: searchRequest });
    const searchPage = await ok(searchResponse, 'Compiled cookie-free REST native search');
    assert.equal(searchResponse.headers()['cache-control'], 'no-store'); assert(Array.isArray(searchPage.hits));
    const hit = searchPage.hits.find(value => object(object(value).document).documentId === editCreated!.document.documentId);
    assert(hit, 'Actual REST search must find the created native document.');
    assert.equal(object(object(hit).document).version, beforeRest.document.version);
    const restReadRequest = { apiVersion: 1, workspaceId: workspace.id, documentId: editCreated.document.documentId,
      format: 'native', expectedVersion: beforeRest.document.version };
    const restRead = await ok(await rest.post('/api/documents/read', { data: restReadRequest }), 'Compiled cookie-free version-bound ID read');
    assert.deepEqual(restRead.document, beforeRest.document);
    const restRequest = { apiVersion: 1, workspaceId: workspace.id, documentId: editCreated.document.documentId,
      expectedVersion: beforeRest.document.version, idempotencyKey: `public-rest-edit-${randomUUID()}`,
      patch: { kind: 'native_text_replace', edits: [{ oldText: 'Keep final tail', newText: 'REST changed final tail', expectedOccurrences: 1 }] } };
    const response = await rest.post('/api/documents/edit', { data: restRequest }); assert.equal(response.status(), 200);
    assert.equal(response.headers()['cache-control'], 'no-store'); const edited = editResultValue(await ok(response, 'Compiled REST native Edit'));
    assert.equal(edited.effect!.beforeVersion, beforeRest.document.version); const afterRest = await editRead(mcpB, edited.effect!.afterVersion); editMatchesRead(edited, afterRest);
    assert(JSON.stringify(nativeJson(afterRest)).includes('REST changed final tail.')); assert(!JSON.stringify(nativeJson(afterRest)).includes('Keep final tail'));
    const prior = await releasedEditRows(); assertRecordedEdit(prior.rows, edited, restIdentity, 'request'); assert.equal((prior.rows.operations as unknown[]).length, 3);
    const restStatus = { apiVersion: 1, workspaceId: workspace.id, operationId: edited.operationId };
    assert.deepEqual(editResultValue(await ok(await rest.post('/api/documents/edit/status', { data: restStatus }), 'Compiled REST pure status')), edited);
    assert.deepEqual(editResultValue(await ok(await rest.post('/api/documents/edit', { data: restRequest }), 'Compiled REST same-key retry')), edited);
    assert.deepEqual((await releasedEditRows()).rows, prior.rows);
    const signed = await ok(await web.request.post('/api/auth/sign-out', { headers: { Origin: origin }, data: {}, maxRedirects: 0 }), 'Revoke actual REST Bearer source session');
    assert.equal(signed.success, true); signedOut.add(web);
    for (const [route, selection] of [['/api/documents/edit', restRequest], ['/api/documents/edit/status', restStatus],
      ['/api/documents/search', searchRequest], ['/api/documents/read', restReadRequest]] as const) {
      const rejected = await rest.post(route, { data: selection }); assert.equal(rejected.status(), 401);
      const denied = await json(rejected, 'Revoked REST native request'); assert.deepEqual(denied, { apiVersion: 1, success: false, code: 'AUTHENTICATION_REQUIRED' });
    }
    const after = await releasedEditRows(); assert.deepEqual(after.rows, prior.rows); await reviewOff(contextB);
    await evidence(info, { scope: 'compiled REST native Edit/Status with actual issued Session Bearer and actual session sign-out',
      cookieFreeBearerConfirmed: true, actualRestSearchAndVersionBoundIdRead: true, revokedSearchAndRead401: true,
      actualRequestOriginAttribution: true, sameKeyNoReplay: true, pureStatusRowsUnchanged: true,
      revokedEditAndStatus401: true, operationId: edited.operationId, fullVersion: edited.effect!.afterVersion, readOnlyProbe: after.probe });
  });
  test.describe('Installed Python wheel and genuine SDK OAuth', () => {
    test('7: installed Python wheel completes real OAuth PKCE and search/read/create/edit reaches the visible editor and reload', async ({ browser: _browser }, info) => {
      assert(contextB && mcpB && identityB && workspace && editCreated);
      const active = contextB, identity = identityB, selected = workspace;
      await reviewOff(active);
      const binding = object(JSON.parse((await privateBytes(path.join(owned.fixtureRoot, 'python-sdk-binding.json'))).toString('utf8')));
      assert.equal(binding.version, 1); assert.equal(typeof binding.python, 'string'); assert(path.isAbsolute(binding.python as string));
      assert.equal(binding.wheelSha256, 'a49b1910b15a915fb1059fe184c28e6db436f7c7a68418e10fe794ac8ad82b7c');
      assert.equal(typeof binding.wheelUri, 'string');
      const wheelUrl = new URL(binding.wheelUri as string); assert.equal(wheelUrl.protocol, 'file:');
      assert(!wheelUrl.host && !wheelUrl.search && !wheelUrl.hash);
      const wheel = fileURLToPath(wheelUrl), wheelStat = await fs.lstat(wheel);
      assert(wheelStat.isFile() && !wheelStat.isSymbolicLink() && wheelStat.uid === process.getuid?.() && wheelStat.size <= 2 * 1024 * 1024);
      assert.equal(await fs.realpath(wheel), wheel); assert.equal(sha(await fs.readFile(wheel)), binding.wheelSha256);
      const helper = path.join(owned.repo, 'scripts/helpers/python_sdk_oauth_browser_probe.py');
      assert.equal(await fs.realpath(helper), helper); assert.equal(sha(await fs.readFile(helper)), binding.helperSha256);
      const settings = object((await ok(await active.request.get('/api/integrations/mcp-server'), 'Observe SDK test settings')).data);
      assert(Array.isArray(settings.capabilities));
      const restore = { enabled: settings.desiredEnabled === true,
        tools: settings.capabilities.filter(value => object(value).enabled === true).map(value => String(object(value).id)) };
      const connections = async (): Promise<Row[]> => {
        const data = object((await ok(await active.request.get('/api/integrations/mcp-server/connections'), 'Observe own SDK connection')).data);
        assert(Array.isArray(data.connections)); return data.connections.map(value => object(value));
      };
      const priorIds = new Set((await connections()).map(value => String(value.connectionId)));
      const probePort = net.createServer();
      await new Promise<void>((resolve, reject) => { probePort.once('error', reject); probePort.listen(0, '127.0.0.1', resolve); });
      const address = probePort.address(); assert(address && typeof address === 'object');
      const callbackPort = address.port;
      await new Promise<void>((resolve, reject) => probePort.close(error => error ? reject(error) : resolve()));
      const redirect = `http://127.0.0.1:${callbackPort}/canvas-sdk-oauth/${randomUUID()}`;
      const metadata = await ok(await active.request.get('/.well-known/oauth-authorization-server/api/auth'), 'Actual SDK authorization metadata');
      assert.equal(metadata.issuer, issuer); assert.equal(typeof metadata.authorization_endpoint, 'string');
      const resource = await ok(await active.request.get('/.well-known/oauth-protected-resource/mcp'), 'Actual SDK resource metadata');
      assert.equal(resource.resource, `${origin}/mcp`);
      assert(Array.isArray(resource.scopes_supported) && resource.scopes_supported.every(scope => typeof scope === 'string'));
      assert(Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.every(scope => typeof scope === 'string'));
      const effectiveScopes = [...new Set([...resource.scopes_supported as string[],
        ...(metadata.scopes_supported.includes('offline_access') ? ['offline_access'] : [])])];
      const seed = await editRead(mcpB);
      const oldText = 'Python OAuth original target 😀', newText = 'Python OAuth changed target 🧪';
      const createPath = `oauth/python-sdk-${randomUUID()}.md`;
      const configuration = { event: 'configure', endpoint: `${origin}/mcp`, issuer, authorizationEndpoint: metadata.authorization_endpoint,
        workspaceId: selected.id, userId: identity.userId, sessionId: identity.sessionId, redirectUri: redirect,
        seedDocumentId: seed.document.documentId, seedVersion: seed.document.version, query: 'REST changed final tail',
        createPath, source: `# Python SDK OAuth\n\n${oldText}.\n\nStable SDK final tail.\n`, oldText, newText,
        createKey: `sdk-oauth-create-${randomUUID()}`, editKey: `sdk-oauth-edit-${randomUUID()}`,
        wheelUri: binding.wheelUri, wheelSha256: binding.wheelSha256, effectiveScopes };
      let sdkConnectionId: string | undefined, created: DocumentCreateMutationResultV1 | undefined;
      let edited: DocumentEditOperationResultV1 | undefined, authenticated: Row | undefined, complete: Row | undefined;
      const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
      const child = spawn(binding.python as string, ['-I', '-B', helper], {
        cwd: owned.fixtureRoot, env: { ...childEnv, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'], detached: false,
      });
      let closed = false, status: number | null = null, termination: NodeJS.Signals | null = null;
      let buffered = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0, failure: Error | undefined;
      const messages: Row[] = [];
      let receiver: (() => void) | undefined;
      const fail = () => { failure ??= new Error('The private installed-wheel OAuth probe failed.'); receiver?.(); };
      child.once('error', fail);
      child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
      const ended = new Promise<void>(resolve => child.once('close', (exitCode, signal) => {
        closed = true; status = exitCode; termination = signal; receiver?.(); resolve();
      }));
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 256 * 1024 || buffered.length + chunk.length > 128 * 1024) { fail(); return; }
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const end = buffered.indexOf(10); if (end < 0) break;
          const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
          if (line.length > 65536) { fail(); continue; }
          try { messages.push(object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))); }
          catch { fail(); }
        }
        if (messages.length > 16 || buffered.length > 65536) fail(); receiver?.();
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
      const next = async (expected: string): Promise<Row> => {
        const deadline = Date.now() + 90000;
        while (!messages.length) {
          if (failure || closed || Date.now() >= deadline) throw new Error('The installed-wheel OAuth probe did not produce its expected bounded step.');
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { receiver = undefined; resolve(); }, Math.min(1000, Math.max(1, deadline - Date.now())));
            receiver = () => { clearTimeout(timer); receiver = undefined; resolve(); };
          });
        }
        if (failure) throw failure;
        const message = messages.shift()!;
        // Never expose a raw protocol message (which may be the authorization
        // URL) in an assertion, stack, reporter or attachment.
        if (message.event === 'failed') {
          const stages = new Set([
            'startup', 'configuration', 'wheel', 'connection', 'workspace_result', 'workspace_shape', 'storage',
            'redirect_binding', 'token_claims', 'document_tools', 'search_read', 'create', 'editor_open', 'edit',
            'editor_verified', 'transport_closed',
          ]);
          const stage = typeof message.stage === 'string' && stages.has(message.stage) ? message.stage : 'unknown';
          const errorType = typeof message.errorType === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u.test(message.errorType)
            ? message.errorType : 'UnknownError';
          throw new Error(`Installed-wheel OAuth probe failed at ${stage} (${errorType}).`);
        }
        if (message.event !== expected) throw new Error('Unexpected installed-wheel OAuth protocol step.');
        return message;
      };
      const send = async (value: Row): Promise<void> => {
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); assert(bytes.length <= 32768);
        await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(new Error('Private SDK input failed.')) : resolve()));
      };
      const timeout = setTimeout(() => { fail(); child.kill('SIGTERM'); }, 165000);
      let page: Awaited<ReturnType<BrowserContext['newPage']>> | undefined, consent: Awaited<ReturnType<BrowserContext['newPage']>> | undefined;
      const errors: unknown[] = [];
      try {
        const configured = object((await ok(await active.request.patch('/api/integrations/mcp-server', {
          data: { enabled: true, tools: [...new Set([...restore.tools, 'list_workspaces', 'search_knowledge'])] },
        }), 'Enable real SDK discovery and search')).data); assert.equal(configured.runtimeEnabled, true);
        await send(configuration);
        const wheelProof = await next('wheel_verified'); assert.equal(wheelProof.sha256, binding.wheelSha256); assert.equal(wheelProof.mcpVersion, '2.3.0');
        const authorization = await next('authorize');
        // URLs and SDK state are kept out of assertions and artifacts. Any
        // browser error from this private OAuth step is sanitized at the edge.
        try {
          assert(typeof authorization.url === 'string' && authorization.url.length <= 16384);
          const target = new URL(authorization.url), declared = new URL(String(metadata.authorization_endpoint));
          assert.equal(target.origin, declared.origin); assert.equal(target.pathname, declared.pathname);
          assert.equal(target.searchParams.get('redirect_uri'), redirect); assert.equal(target.searchParams.get('resource'), `${origin}/mcp`);
          assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
          const redirectUrl = new URL(redirect);
          consent = await active.newPage();
          const callback = consent.waitForResponse(response => {
            const actual = new URL(response.url()); return actual.origin === redirectUrl.origin && actual.pathname === redirectUrl.pathname;
          }, { timeout: 75000 }).catch(() => undefined);
          // The actual callback request reaches CanvasOAuth's real listener.
          // No route interception, callback emulation or manual token exchange.
          await consent.goto(authorization.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const accept = consent.locator('button[name="accept"][value="true"]');
          await expect(accept).toBeVisible({ timeout: 45000 }); await accept.click();
          const delivered = await callback; assert(delivered); assert.equal(delivered.status(), 200); await delivered.finished();
          await expect(consent.getByText('Authorization received. You may close this window.', { exact: true })).toBeVisible();
          const added = (await connections()).filter(value => !priorIds.has(String(value.connectionId)));
          assert.equal(added.length, 1); assert.equal(added[0].clientName, 'Canvas Notebook Python');
          assert(typeof added[0].connectionId === 'string'); sdkConnectionId = added[0].connectionId;
          await ok(await active.request.put('/api/integrations/mcp-server/connections/workspaces', {
            data: { connectionId: sdkConnectionId, workspaceIds: [selected.id] },
          }), 'Grant only owned SDK workspace');
          await send({ event: 'authorized' });
        } catch { throw new Error('Actual SDK OAuth browser consent or callback failed.'); }
        finally { authorization.url = undefined; if (consent) { await consent.close(); consent = undefined; } }
        authenticated = await next('authenticated');
        assert.equal(authenticated.userId, identity.userId); assert.equal(authenticated.sessionId, identity.sessionId);
        assert.equal(authenticated.issuerAndResourceBound, true); assert.equal(authenticated.realPkceExchangeCompleted, true);
        assert(typeof authenticated.clientId === 'string' && authenticated.clientId.length > 0);
        const searched = await next('searched_and_read'); assert.deepEqual(searched.document, seed.document);
        assert(Number.isSafeInteger(searched.pageCount) && Number(searched.pageCount) > 1);
        assert.equal(searched.bodySha256, sha(seed.fragment));
        const createdMessage = await next('created'); created = object(createdMessage.result) as unknown as DocumentCreateMutationResultV1;
        assert.equal(created.apiVersion, 1); assert.equal(created.outcome, 'created'); assert.equal(created.document.workspaceId, selected.id);
        assert.equal(created.document.path, createPath); assert.equal(created.document.representation, 'tiptap_blocks');
        assert.match(created.document.version, /^canvas-document-v1:[a-f0-9]{64}$/u);
        assert.equal(typeof createdMessage.body, 'string');
        const beforeBody = object(JSON.parse(createdMessage.body as string));
        assert.equal(beforeBody.bodyVersion, 1); assert.equal(object(beforeBody.content).kind, 'rich_text');
        const beforeJson = object(object(beforeBody.content).document);
        page = await active.newPage();
        await page.addInitScript(({ id, host }) => { if (location.origin === host) { localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false'); } }, { id: selected.id, host: origin });
        await page.goto(`/en/notebook?workspaceId=${encodeURIComponent(selected.id)}&path=${encodeURIComponent(created.document.path)}`, { waitUntil: 'domcontentloaded' });
        let editor = page.locator(editorSelector); await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 });
        await expect(editor).toBeVisible(); await expect(editor).toContainText(oldText);
        await expect.poll(async () => (await readNativeRichCandidate(page!, editorSelector)).document, { timeout: 30000 }).toEqual(beforeJson);
        await send({ event: 'editor_open' });
        const changed = await next('edited'); edited = editResultValue(changed.result);
        assert.equal(edited.document.documentId, created.document.documentId); assert.equal(edited.effect!.beforeVersion, created.document.version);
        const afterDocument = object(changed.document); assert.equal(afterDocument.version, edited.effect!.afterVersion);
        assert.equal(afterDocument.documentId, created.document.documentId); assert.equal(typeof changed.body, 'string');
        const afterBody = object(JSON.parse(changed.body as string)), afterJson = object(object(afterBody.content).document);
        await expect(editor).toBeVisible(); await expect(editor).toContainText(newText); await expect(editor).not.toContainText(oldText);
        await expect.poll(async () => (await readNativeRichCandidate(page!, editorSelector)).document, { timeout: 30000 }).toEqual(afterJson);
        await page.reload({ waitUntil: 'domcontentloaded' }); editor = page.locator(editorSelector);
        await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 45000 }); await expect(editor).toBeVisible();
        await expect(editor).toContainText(newText); await expect(editor).not.toContainText(oldText);
        await expect.poll(async () => (await readNativeRichCandidate(page!, editorSelector)).document, { timeout: 30000 }).toEqual(afterJson);
        await page.screenshot({ path: info.outputPath('python-sdk-oauth-visible-editor-reloaded.png'), animations: 'disabled' });
        await send({ event: 'editor_verified' }); complete = await next('complete');
        child.stdin.end(); await ended;
        assert.equal(status, 0); assert.equal(termination, null); assert.equal(stderrBytes, 0); assert.equal(buffered.length, 0); assert.equal(messages.length, 0);
        assert.equal(complete.actualOAuth, true); assert.equal(complete.authorizations, 1); assert.equal(complete.transportClosed, true);
      } catch (error) { errors.push(error); }
      finally {
        clearTimeout(timeout); child.stdin.end();
        if (!closed) {
          child.kill('SIGTERM');
          await Promise.race([ended, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
          if (!closed) { child.kill('SIGKILL'); await Promise.race([ended, new Promise<void>(resolve => setTimeout(resolve, 3000))]); }
        }
        if (!closed) errors.push(new Error('The owned Python SDK child did not close.'));
        for (const opened of [consent, page]) if (opened) { try { await opened.close(); } catch { errors.push(new Error('Own SDK browser page did not close.')); } }
        try {
          const added = (await connections()).filter(value => !priorIds.has(String(value.connectionId)));
          if (!sdkConnectionId && added.length === 1 && added[0].clientName === 'Canvas Notebook Python') sdkConnectionId = String(added[0].connectionId);
          assert(added.every(value => value.connectionId === sdkConnectionId), 'Unexpected additional OAuth connection; preserve its identity.');
          if (sdkConnectionId && added.some(value => value.connectionId === sdkConnectionId)) {
            await ok(await active.request.delete('/api/integrations/mcp-server/connections', { data: { connectionId: sdkConnectionId } }), 'Revoke only the actual SDK connection');
          }
          assert(!(await connections()).some(value => value.connectionId === sdkConnectionId));
        } catch { errors.push(new Error('Own SDK OAuth connection cleanup remained unconfirmed.')); }
        try {
          await ok(await active.request.patch('/api/integrations/mcp-server', { data: restore }), 'Restore SDK test MCP settings');
          await ok(await active.request.patch('/api/integrations/mcp-server', { data: restore }), 'Restore exact SDK test capability selection');
          await reviewOff(active);
        } catch { errors.push(new Error('Own SDK test settings restore remained unconfirmed.')); }
      }
      if (errors.length) throw new AggregateError(errors, 'Installed-wheel OAuth browser acceptance or own cleanup failed.');
      assert(created && edited && authenticated && complete && sdkConnectionId);
      await evidence(info, { scope: 'installed Python wheel + official MCP2.3 OAuthCode/PKCE + compiled Canvas + visible native editor/reload',
        installedWheelSha256: binding.wheelSha256, officialMcpVersion: '2.3.0', actualOAuth: true, actualCallbackReceiver: true,
        currentSessionBinding: true, issuerAndResourceBound: true, workspaceGrantBound: true, progressiveSearchAndMultipageIdRead: true,
        actualNativeCreateAndEditStatus: true, visibleEditorAndReloadMatchNativeJson: true, ownPythonClosed: true,
        ownSdkConnectionRevoked: true, operationId: edited.operationId, documentId: created.document.documentId, fullVersion: edited.effect!.afterVersion });
    });
  });
});
