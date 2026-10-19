import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import type { DocumentReadPageV1 } from '../app/lib/documents/contracts';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Actual Next POST exports, bounded Request bodies and genuine member sessions
// enter the shared import/read coordinators. No handler, principal, SQL result
// or authority is replaced. This is handler/PG/FD evidence, not TCP or browser.
let phase = 'fixture', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

export async function explicitOriginalMarkdownImportHttpPostgresTest(): Promise<void> {
  const previousBase = process.env.BASE_URL; process.env.BASE_URL = 'http://localhost';
  try { await withNativeCopyMetadataOwnerFixture(async h => {
    const { POST: importPost } = await import('../app/api/documents/import-existing/route');
    const { POST: statusPost } = await import('../app/api/documents/import-existing/status/route');
    const { POST: readPost } = await import('../app/api/documents/read/route');
    const { filesystemFileVersion } = await import('../app/lib/filesystem/file-version');
    const { loadCollaborationStateOnConnection: load, serializeCanonicalText } = await import('../app/lib/collaboration/persistence');
    const { inspectPersistedNativeCollaborationSnapshot: inspect } = await import('../app/lib/collaboration/document-snapshot');
    const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { auth } = await import('../app/lib/auth');
    const workspace = h.destination;
    assert.equal(workspace.permissions.canWrite, true); assert.equal(h.source.permissions.canWrite, false);
    const bearer = await h.request(workspace, 'member', false), cookie = await h.request(workspace, 'member', true);
    assert(bearer.headers.get('authorization')?.startsWith('Bearer ')); assert(cookie.headers.get('cookie'));
    for (const actual of [bearer, cookie]) {
      const session = await auth.api.getSession({ headers: actual.headers });
      assert.equal(session?.user.id, 'member'); assert.equal(session?.session.id, 'session-member');
    }
    type Selection = { apiVersion: 1; workspaceId: string; path: string; operationId: string; expectedFileVersion: string;
      initialRepresentation?: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' };
    const selection = async (filePath: string, selected = workspace): Promise<Selection> => ({ apiVersion: 1,
      workspaceId: selected.workspaceId, path: filePath, operationId: `http_original_${crypto.randomUUID().replaceAll('-', '')}`,
      expectedFileVersion: filesystemFileVersion(await fs.lstat(path.join(selected.rootPath, filePath))) });
    const request = (route: 'import-existing' | 'import-existing/status' | 'read', body: string | Uint8Array,
      credential: NextRequest | null = bearer) => {
      const headers = new Headers(credential?.headers); headers.set('content-type', 'application/json');
      return new NextRequest(`http://localhost/api/documents/${route}`, { method: 'POST', headers,
        body: typeof body === 'string' ? body : new Uint8Array(body) });
    };
    let importCalls = 0;
    const invokeImport = (actual: NextRequest) => { importCalls++; return importPost(actual); };
    const secure = (response: Response) => {
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('pragma'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/u);
    };
    const exactKeys = (value: object, expected: readonly string[]) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
    const failure = async (response: Response, status: number, code: string) => {
      secure(response); assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { apiVersion: 1, success: false, code });
    };
    const confirmed = async (response: Response, receipt: MarkdownFileImportReceipt, outcome: 'imported' | 'already_imported') => {
      secure(response); assert.equal(response.status, 200); const body = await response.json();
      exactKeys(body, ['apiVersion', 'operationId', 'status', 'outcome', 'documentAtImport', 'source', 'requiresFreshFileActionPreview']);
      exactKeys(body.documentAtImport, ['workspaceId', 'organizationId', 'documentId', 'lineageId', 'path', 'representation',
        'lifecycleGeneration', 'schemaVersion', 'documentSequence', 'stateProof', 'persistedAt']);
      exactKeys(body.source, ['sha256', 'bytes']);
      assert.deepEqual(body, { apiVersion: 1, operationId: receipt.operationId, status: 'confirmed', outcome,
        documentAtImport: { workspaceId: receipt.target.workspaceId, organizationId: receipt.target.organizationId,
          documentId: receipt.target.documentId, lineageId: receipt.target.lineageId, path: receipt.target.path,
          representation: receipt.target.representation, lifecycleGeneration: receipt.target.lifecycleGeneration,
          schemaVersion: receipt.target.schemaVersion, documentSequence: receipt.target.initialSequence,
          stateProof: receipt.target.initialStateProof, persistedAt: receipt.target.persistedAt },
        source: { sha256: receipt.sourceHash, bytes: receipt.sourceBytes }, requiresFreshFileActionPreview: true });
      // Exact keys also exclude actor/session, fingerprints, native payloads,
      // projection.current and any current-location/version assertion.
      return body;
    };
    const storedReceipt = async (input: Selection): Promise<MarkdownFileImportReceipt> => {
      const rows = (await h.admin.query(`SELECT r.private_result,r.actor_user_id,r.actor_session_id,r.request_id,
        d.id,d.lineage_id,s.document_sequence,s.lifecycle_generation,s.schema_version,s.representation,
        o.original_text FROM collaboration_markdown_file_import_receipts r
        JOIN collaboration_original_markdown_imports o USING(workspace_id,operation_id)
        JOIN collaboration_documents d ON d.id=r.private_result->'target'->>'documentId'
        JOIN collaboration_yjs_states s ON s.document_id=d.id
        WHERE r.workspace_id=$1 AND r.operation_id=$2`, [workspace.workspaceId, input.operationId])).rows;
      assert.equal(rows.length, 1); const row = rows[0], receipt = row.private_result as MarkdownFileImportReceipt;
      assert.equal(row.actor_user_id, 'member'); assert.equal(row.actor_session_id, 'session-member');
      assert.equal(row.request_id, `original-import:${input.operationId}`);
      assert.equal(row.id, receipt.target.documentId); assert.equal(row.lineage_id, receipt.target.lineageId);
      assert.equal(Number(row.document_sequence), receipt.target.initialSequence);
      assert.equal(Number(row.lifecycle_generation), receipt.target.lifecycleGeneration);
      assert.equal(Number(row.schema_version), receipt.target.schemaVersion); assert.equal(row.representation, receipt.target.representation);
      assert.deepEqual(JSON.parse(row.original_text).receipt, receipt); return receipt;
    };
    const filesystem = async () => {
      const rows: unknown[] = [], pending = ['.'];
      while (pending.length) {
        assert(rows.length < 10000); const relative = pending.shift()!, file = path.join(h.dataRoot, relative);
        const value = await fs.lstat(file, { bigint: true }); assert(!value.isSymbolicLink());
        const identity = { path: relative, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode),
          uid: String(value.uid), gid: String(value.gid), size: String(value.size), nlink: String(value.nlink),
          mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs) };
        rows.push(value.isFile() ? { ...identity, sha256: crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') } : identity);
        if (value.isDirectory()) pending.push(...(await fs.readdir(file)).sort().map(name => path.join(relative, name)));
      }
      return rows;
    };
    const domain = async () => {
      const tables = (await h.admin.query(`SELECT c.relname,c.oid::text AS oid FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'
        AND (c.relname ~ '^(collaboration_|file_collaboration_|workspace_file_)'
          OR c.relname IN ('file_revisions','file_revision_contents','file_version_blobs','workspace_trash_entries'))
        ORDER BY c.relname LIMIT 513`, [h.schema])).rows;
      assert(tables.length > 15 && tables.length <= 512); const rows: Record<string, unknown> = {};
      for (const table of tables) {
        assert.equal(typeof table.relname, 'string'); const name = `"${String(table.relname).replaceAll('"', '""')}"`;
        rows[table.relname] = (await h.admin.query(`SELECT to_jsonb(t)::text AS body,t.xmin::text AS xmin FROM ${name} t
          ORDER BY to_jsonb(t)::text,t.xmin::text LIMIT 10001`)).rows;
        assert((rows[table.relname] as unknown[]).length <= 10000);
      }
      return { tables, rows };
    };
    // Fixture setup, raw-file creation, credential construction and admin row
    // inspection happen OUTSIDE this window. Inside: actual POST handler only.
    // NoWrite proves all observed runtime-pool DML/DDL/notify absent, unchanged
    // collaboration-domain row bodies+xmin, and exact owned DATA file profiles.
    const noWrites = async <T>(operation: () => Promise<T>, requireStatements = true): Promise<T> => {
      const before = await domain(), files = await filesystem(); let statements = 0, writes = 0;
      try { return await h.withProbe(async event => {
        assert(++statements <= 5000);
        if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?|UPDATE\s+[\s\S]*?\bSET\b|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX))\b/iu.test(event.text)
          || /\bpg_notify\s*\(/iu.test(event.text)) writes++;
      }, operation); }
      finally { if (requireStatements) assert(statements > 0); assert.equal(writes, 0);
        assert.deepEqual(await domain(), before); assert.deepEqual(await filesystem(), files); }
    };

    phase = 'actual Cookie/Bearer import POST confirms real IDs and two unchanged original byte profiles';
    const profiles = [
      { path: 'http-original-profile.md', representation: 'plain_text' as const,
        bytes: Buffer.from('\uFEFF---\r\ntitle: HTTP original\r\n---\r\n\r\n# Quelle\r\n\r\nÄ Ω 🙂 and [self](http-original-profile.md).\r\n'), credential: cookie },
      { path: 'http-original-blocks.markdown', representation: 'tiptap_blocks' as const,
        bytes: Buffer.from('# HTTP Blocks\n\n**Bold** and [self](http-original-blocks.markdown).\n'), credential: bearer },
    ];
    const imported: Array<{ input: Selection; receipt: MarkdownFileImportReceipt; canonical: string }> = [];
    for (const profile of profiles) {
      const file = path.join(workspace.rootPath, profile.path);
      await fs.writeFile(file, profile.bytes, { mode: 0o600, flag: 'wx' });
      const input = { ...await selection(profile.path), initialRepresentation: profile.representation };
      assert.equal((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
        [workspace.workspaceId, profile.path])).rows[0].n, 0);
      const response = await invokeImport(request('import-existing', JSON.stringify(input), profile.credential));
      secure(response); assert.equal(response.status, 200);
      const receipt = await storedReceipt(input); await confirmed(response, receipt, 'imported');
      assert.equal(receipt.target.workspaceId, workspace.workspaceId); assert.equal(receipt.target.path, profile.path);
      assert.equal(receipt.target.representation, profile.representation); assert.equal(receipt.target.initialSequence, 0);
      assert.equal(receipt.sourceHash, crypto.createHash('sha256').update(profile.bytes).digest('hex'));
      assert.equal(receipt.sourceBytes, profile.bytes.byteLength);
      const state = await load(h.connection, receipt.target.documentId); assert(state);
      const canonical = inspect(state, (doc, snapshot) => snapshot.content.kind === 'plain_text'
        ? snapshot.content.text : richMarkdownFromYDoc(doc));
      assert.deepEqual(Buffer.from(serializeCanonicalText(canonical, state)), profile.bytes);
      assert.equal(state.hasBom, profile.representation === 'plain_text');
      assert.equal(state.newlineStyle, profile.representation === 'plain_text' ? 'crlf' : 'lf');
      assert.deepEqual(await fs.readFile(file), profile.bytes);
      assert.equal(filesystemFileVersion(await fs.lstat(file)), input.expectedFileVersion);
      imported.push({ input, receipt, canonical });
    }
    groups++;

    phase = 'confirmed HTTP retry and confirmed/missing status POST preserve all domain and owned DATA facts';
    const first = imported[0];
    const retry = request('import-existing', JSON.stringify(first.input), bearer);
    await noWrites(async () => confirmed(await invokeImport(retry), first.receipt, 'already_imported'));
    const statusInput = { apiVersion: 1, workspaceId: workspace.workspaceId, operationId: first.input.operationId };
    const knownStatus = request('import-existing/status', JSON.stringify(statusInput), cookie);
    await noWrites(async () => confirmed(await statusPost(knownStatus), first.receipt, 'already_imported'));
    const unknownId = `unknown_http_${crypto.randomUUID().replaceAll('-', '')}`;
    const unknownStatus = request('import-existing/status', JSON.stringify({ ...statusInput, operationId: unknownId }), bearer);
    await noWrites(async () => {
      const response = await statusPost(unknownStatus); secure(response); assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { apiVersion: 1, operationId: unknownId, status: 'not_found', requiresFreshFileActionPreview: true });
    }); groups++;

    phase = 'actual ID read POST returns imported native content and honest pending checkpoint without source mutation';
    for (const item of imported) {
      const readRequest = request('read', JSON.stringify({ apiVersion: 1, workspaceId: workspace.workspaceId,
        documentId: item.receipt.target.documentId, format: 'markdown', maxBytes: 262144 }), cookie);
      await noWrites(async () => {
        const response = await readPost(readRequest); secure(response); assert.equal(response.status, 200);
        const page = await response.json() as DocumentReadPageV1;
        assert.equal(page.document.documentId, item.receipt.target.documentId); assert.equal(page.document.lineageId, item.receipt.target.lineageId);
        assert.equal(page.document.workspaceId, workspace.workspaceId); assert.equal(page.document.path, item.input.path);
        assert.equal(page.document.representation, item.receipt.target.representation);
        assert.equal(page.complete, true); assert.equal(page.nextCursor, null); assert.equal(page.fragment, item.canonical);
        assert.equal(page.projection.status, 'pending'); assert.equal(page.currency.observedDurable, true);
      });
    } groups++;

    phase = 'actual bounded HTTP body/schema failures are safe 400 with no domain, SQL or DATA mutation';
    const { path: _missingPath, ...missingPath } = first.input;
    const invalidBodies = ['{broken', JSON.stringify({ ...first.input, extra: 'must not be accepted' }), JSON.stringify(missingPath),
      JSON.stringify({ ...first.input, operationId: 'bad/id' }), JSON.stringify({ ...first.input, operationId: 'short' }),
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])];
    for (const body of invalidBodies) {
      const invalidRequest = request('import-existing', body, cookie);
      await noWrites(async () => failure(await invokeImport(invalidRequest), 400, 'MARKDOWN_IMPORT_INVALID_INPUT'), false);
    }
    for (const input of [{ ...statusInput, extra: 'not a grant' }, { apiVersion: 1, workspaceId: workspace.workspaceId },
      { ...statusInput, operationId: 'bad/id' }]) {
      const invalidRequest = request('import-existing/status', JSON.stringify(input), bearer);
      await noWrites(async () => failure(await statusPost(invalidRequest), 400, 'MARKDOWN_IMPORT_INVALID_INPUT'), false);
    }
    const largeBytes = Buffer.from(JSON.stringify({ ...first.input, padding: '🙂'.repeat(9000) }));
    assert(largeBytes.byteLength > 32 * 1024);
    let canceled = false, laterPulls = 0;
    const largeBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(largeBytes)); },
      pull() { laterPulls++; throw new Error('The bounded adapter must cancel before requesting later body bytes.'); },
      cancel() { canceled = true; } }, { highWaterMark: 0 });
    const largeHeaders = new Headers(cookie.headers); largeHeaders.set('content-type', 'application/json');
    const largeInit: NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex: 'half' } = {
      method: 'POST', headers: largeHeaders, body: largeBody, duplex: 'half',
    };
    const largeRequest = new NextRequest('http://localhost/api/documents/import-existing', largeInit);
    await noWrites(async () => failure(await invokeImport(largeRequest), 400, 'MARKDOWN_IMPORT_INVALID_INPUT'), false);
    assert.equal(canceled, true); assert.equal(laterPulls, 0); groups++;

    phase = 'genuine missing and invalid member credentials produce sanitized HTTP 401 without domain writes';
    const absentAuth = request('import-existing', JSON.stringify(first.input), null);
    await noWrites(async () => failure(await invokeImport(absentAuth), 401, 'IMPORT_AUTHENTICATION_REQUIRED'), false);
    const invalidAuth = request('import-existing/status', JSON.stringify(statusInput), null);
    invalidAuth.headers.set('authorization', 'Bearer invalid-http-import-fixture-credential');
    await noWrites(async () => failure(await statusPost(invalidAuth), 401, 'IMPORT_AUTHENTICATION_REQUIRED'), false); groups++;

    phase = 'actual read-only workspace member is denied by both HTTP write-import and historical status';
    const readonlyPath = 'http-readonly-original.md', readonlyBytes = Buffer.from('# Read only original\n');
    await fs.writeFile(path.join(h.source.rootPath, readonlyPath), readonlyBytes, { mode: 0o600, flag: 'wx' });
    const readonlySelection = await selection(readonlyPath, h.source), readonlyCredential = await h.request(h.source, 'member', true);
    const readonlyImport = request('import-existing', JSON.stringify(readonlySelection), readonlyCredential);
    await noWrites(async () => failure(await invokeImport(readonlyImport), 403, 'IMPORT_ACCESS_DENIED'), false);
    const readonlyStatus = request('import-existing/status', JSON.stringify({ apiVersion: 1,
      workspaceId: h.source.workspaceId, operationId: readonlySelection.operationId }), readonlyCredential);
    await noWrites(async () => failure(await statusPost(readonlyStatus), 403, 'IMPORT_ACCESS_DENIED'), false); groups++;

    phase = 'original import rate limiter retains security headers and rejects before body/auth at its fixed budget';
    await noWrites(async () => {
      while (importCalls < 60) {
        const response = await invokeImport(request('import-existing', '{broken', cookie));
        await failure(response, 400, 'MARKDOWN_IMPORT_INVALID_INPUT');
      }
      const response = await invokeImport(request('import-existing', '', cookie)); secure(response);
      assert.equal(response.status, 429); assert.match(response.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/u);
      assert.deepEqual(await response.json(), { success: false, error: 'Too many requests' });
    }, false); groups++;
    assert.equal(groups, 7);
  });
  complete = true;
  console.log(JSON.stringify({ suite: 'explicit-original-import-http', groups, actualHandlers: true, actualPostgres: true,
    cookieAndBearer: true, browserOrTcp: false }));
  } finally { if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase; }
}

explicitOriginalMarkdownImportHttpPostgresTest().catch(error => {
  const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown : undefined;
  console.error(JSON.stringify({ suite: 'explicit-original-import-http', phase, groups,
    name: error instanceof Error ? error.name : 'UnknownError',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : null }));
  process.exitCode = 1;
});
